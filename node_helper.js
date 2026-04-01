const NodeHelper = require("node_helper");
const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");
const stream = require("stream");
const { promisify } = require("util");
const pipeline = promisify(stream.pipeline);
const sharp = require("sharp");
const { exec } = require("child_process");

module.exports = NodeHelper.create({
    start: function () {
        console.log("Starting node_helper for: " + this.name);
        this.cacheDir = path.join(__dirname, "public/cache");
        this.ensureCacheDir();
    },

    ensureCacheDir: function () {
        if (!fs.existsSync(this.cacheDir)) {
            console.log("MMM-Art: Creating cache directory: " + this.cacheDir);
            fs.mkdirSync(this.cacheDir, { recursive: true });
        }
    },

    socketNotificationReceived: function (notification, payload) {
        if (notification === "FETCH_ARTWORK") {
            this.fetchArtwork(payload);
        }
        if (notification === "LOG") {
            console.log("[MMM-Art] " + payload);
        }
        if (notification === "RESOLUTION") {
            console.log("[MMM-Art] Received resolution: " + payload.width + "x" + payload.height);
            this.config = this.config || {};
            this.config.resolution = payload;
        }
    },

    // Helper: Download raw image
    downloadRaw: async function (url, dest) {
        console.log("MMM-Art: Downloading " + url + "...");
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 60000); // 60s timeout for raw download

        try {
            const response = await fetch(url, {
                headers: { 'User-Agent': 'MMM-Art/1.0' },
                signal: controller.signal
            });

            clearTimeout(timeout);
            if (!response.ok) throw new Error(`Unexpected response ${response.statusText}`);

            await pipeline(response.body, fs.createWriteStream(dest));
            console.log("MMM-Art: Download finished: " + path.basename(dest));
        } catch (e) {
            clearTimeout(timeout);
            if (fs.existsSync(dest)) fs.unlinkSync(dest); // Cleanup partial
            throw e;
        }
    },

    // Helper: Resize with ImageMagick (Fallback)
    resizeWithImageMagick: function (src, dest, width, height) {
        return new Promise((resolve, reject) => {
            // Use 'convert' to resize. 
            // -resize WxH\> only shrinks if larger (standard behavior)
            // -quality 80
            const cmd = `convert "${src}" -resize ${width}x${height}\\> -quality 80 "${dest}"`;
            console.log("MMM-Art: ImageMagick fallback: " + cmd);

            exec(cmd, (error, stdout, stderr) => {
                if (error) {
                    reject(error);
                } else {
                    resolve();
                }
            });
        });
    },

    // Helper: Resize image
    resizeImage: async function (src, dest, lockPath) {
        console.log("MMM-Art: Resizing " + path.basename(src) + " started...");

        // Poison Pill Check
        if (fs.existsSync(lockPath)) {
            console.log("MMM-Art: Poison Pill detected for " + path.basename(dest) + ". Skipping resize.");

            // OLD BEHAVIOR: Copy raw original (Causes broken image in frontend if huge)
            // fs.copyFileSync(src, dest);

            // NEW BEHAVIOR: Strict Skip.
            // Do NOT copy. Do NOT create final.
            // Remove lock so we *might* try again later? Or keep it to skip forever?
            // If we remove lock, it loops.
            // If we keep lock, we skip resize. But if final doesn't exist, processResults won't show it.
            // PERFECT.
            console.log("MMM-Art: Skipping " + path.basename(dest) + " entirely to prevent broken UI.");
            return;
        }

        const tempDest = dest.replace(".jpg", "_temp.jpg"); // Temporary output for resize

        try {
            // Create Lock
            fs.writeFileSync(lockPath, "processing");

            const width = (this.config && this.config.resolution) ? this.config.resolution.width : 1920;
            const height = (this.config && this.config.resolution) ? this.config.resolution.height : 1080;

            console.log("MMM-Art: Resizing to " + width + "x" + height);

            try {
                // Attempt 1: Sharp
                await sharp(src, { limitInputPixels: false })
                    .resize({
                        width: width,
                        height: height,
                        fit: 'inside',
                        withoutEnlargement: true
                    })
                    .jpeg({ quality: 80 })
                    .toFile(tempDest);
            } catch (sharpError) {
                console.error("MMM-Art: Sharp failed (" + sharpError.message + "). Trying ImageMagick...");
                // Attempt 2: ImageMagick
                await this.resizeWithImageMagick(src, tempDest, width, height);
            }

            console.log("MMM-Art: Resizing finished: " + path.basename(dest));

            // Rename temp to final
            fs.renameSync(tempDest, dest);

            // Cleanup Lock (Success)
            if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);

        } catch (e) {
            console.error("MMM-Art: Resize failed for " + path.basename(src), e);
            if (fs.existsSync(tempDest)) fs.unlinkSync(tempDest);
            // Leave lock file so we know it crashed/failed next time (Poison Pill)
            throw e;
        }
    },

    fetchArtwork: async function (artworkIds) {
        if (!artworkIds || artworkIds.length === 0) return;

        // Construct SPARQL query
        const valuesPart = artworkIds.map(id => `wd:${id}`).join(" ");

        const query = `
      SELECT ?painting ?paintingLabel ?title ?image ?artist ?artistLabel ?artistBirth ?artistDeath ?date ?collection ?collectionLabel ?description WHERE {
        VALUES ?painting { ${valuesPart} }
        
        SERVICE wikibase:label { bd:serviceParam wikibase:language "[AUTO_LANGUAGE],en". }

        ?painting wdt:P18 ?image.
        
        OPTIONAL { 
          ?painting wdt:P1476 ?title. 
        }
        OPTIONAL { 
          ?painting wdt:P170 ?artist. 
          OPTIONAL { ?artist wdt:P569 ?artistBirth. }
          OPTIONAL { ?artist wdt:P570 ?artistDeath. }
        }
        OPTIONAL { ?painting wdt:P571 ?date. }
        OPTIONAL { ?painting wdt:P195 ?collection. }
        OPTIONAL { 
          ?painting schema:description ?description. 
          FILTER (lang(?description) = "en") 
        }
      }
    `;

        const url = `https://query.wikidata.org/sparql?query=${encodeURIComponent(query)}&format=json`;

        let attempts = 0;
        const maxAttempts = 3;
        const timeoutMs = 15000;

        while (attempts < maxAttempts) {
            try {
                attempts++;
                console.log(`MMM-Art: Requesting URL (Attempt ${attempts}/${maxAttempts}): ${url}`);

                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), timeoutMs);

                const response = await fetch(url, {
                    headers: {
                        'User-Agent': 'MMM-Art/1.0 (MagicMirror Module; https://github.com/yourusername/mmm-art)',
                        'Accept': 'application/sparql-results+json'
                    },
                    signal: controller.signal
                });

                clearTimeout(timeout);

                if (!response.ok) {
                    const errText = await response.text();
                    console.error("MMM-Art: API Error Body: " + errText);
                    throw new Error(`Wikidata API error: ${response.statusText}`);
                }

                const data = await response.json();
                console.log("MMM-Art: Data received, binding count: " + (data.results && data.results.bindings ? data.results.bindings.length : "0"));

                // Save raw data for re-processing during incremental updates
                this.lastData = data;

                // 1. Get List for Display (Strict Filter)
                const displayResults = this.processResults(data);

                // 2. Get List for Background Cache (All Candidates)
                const cacheCandidates = this.getAllCandidates(data);

                // UNBLOCK FRONTEND
                console.log("MMM-Art: Sending " + displayResults.length + " items to frontend (Background caching started).");
                this.sendSocketNotification("ARTWORK_DATA", displayResults);

                // Start background caching with FULL list
                this.backgroundCache(cacheCandidates);

                return;

            } catch (error) {
                console.error(`MMM-Art: Error fetching data (Attempt ${attempts}):`, error.message);
                if (attempts === maxAttempts) {
                    console.error("MMM-Art: Max attempts reached. Failing.");
                } else {
                    const delay = 3000 * attempts;
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }
    },

    processResults: function (data) {
        if (!data.results || !data.results.bindings) return [];

        const seenIds = new Set();
        const results = [];

        data.results.bindings.forEach(b => {
            const id = b.painting.value;
            if (seenIds.has(id)) return;
            seenIds.add(id);

            const val = (prop) => prop ? prop.value : null;

            let imageUrl = val(b.image);
            if (imageUrl && imageUrl.startsWith("http://")) {
                imageUrl = imageUrl.replace("http://", "https://");
            }

            // Check local cache status
            let localUrl = null;
            if (imageUrl) {
                let ext = path.extname(imageUrl) || ".jpg";
                if (ext.includes("?")) ext = ext.split("?")[0];
                const idPart = id.split("/").pop();
                const filename = `${idPart}${ext}`.replace(/%20/g, "_");

                const finalPath = path.join(this.cacheDir, filename);
                const origPath = path.join(this.cacheDir, "orig_" + filename);

                try {
                    // Prefer FINAL
                    if (fs.existsSync(finalPath) && fs.statSync(finalPath).size > 0) {
                        localUrl = `/modules/MMM-Art/public/cache/${filename}`;
                    }
                    // Fallback to ORIG (if requested to show strictly downloaded)
                    else if (fs.existsSync(origPath) && fs.statSync(origPath).size > 0) {
                        localUrl = `/modules/MMM-Art/public/cache/orig_${filename}`;
                    }
                } catch (e) { }
            }

            // STRICT MODE: Only add if we have a local URL
            if (localUrl) {
                results.push({
                    id: id,
                    image: localUrl,
                    originalUrl: imageUrl, // Keep ref for background downloader
                    title: val(b.title) || val(b.paintingLabel),
                    artist: val(b.artistLabel),
                    artistBirth: val(b.artistBirth),
                    artistDeath: val(b.artistDeath),
                    date: val(b.date),
                    collection: val(b.collectionLabel),
                    description: val(b.description)
                });
            } else {
                // We still need to track it for background downloading, but don't show it yet.
                // Actually, backgroundCache iterates 'results'. If we exclude it here, backgroundCache won't see it?
                // PROBLEM: If we exclude it from 'results', backgroundCache won't download it.
                // FIX: Pass all items to backgroundCache, but only send filtered list to frontend?
                // OR: Include it in results but mark it hidden? Frontend doesn't support hidden.
                // BETTER FIX: 'results' contains ONLY displayable items. 
                // We need a separate list for 'allCandidates' or just re-parse data in backgroundCache?
                // Let's pass 'allCandidates' to backgroundCache.
            }
        });

        // This function now returns only displayable items
        return results;
    },

    // We need a helper to get ALL candidates for the downloader
    getAllCandidates: function (data) {
        if (!data.results || !data.results.bindings) return [];
        const seenIds = new Set();
        const results = [];
        data.results.bindings.forEach(b => {
            const id = b.painting.value;
            if (seenIds.has(id)) return;
            seenIds.add(id);
            const val = (prop) => prop ? prop.value : null;
            let imageUrl = val(b.image);
            if (imageUrl && imageUrl.startsWith("http://")) {
                imageUrl = imageUrl.replace("http://", "https://");
            }
            results.push({
                id: id,
                image: imageUrl || "",
                title: val(b.title) || val(b.paintingLabel)
            });
        });
        return results;
    },

    backgroundCache: async function (allCandidates) {
        console.log("MMM-Art: Starting background caching loop (" + allCandidates.length + " candidates)...");

        // === PHASE 1: BATCH DOWNLOAD ===
        console.log("MMM-Art: Phase 1 - Batch Download Originals");
        for (const item of allCandidates) {
            if (!item.image || !item.image.startsWith("http")) continue;

            const idPart = item.id.split("/").pop();
            let ext = path.extname(item.image) || ".jpg";
            if (ext.includes("?")) ext = ext.split("?")[0];
            const filename = `${idPart}${ext}`.replace(/%20/g, "_");

            const finalPath = path.join(this.cacheDir, filename);
            const origPath = path.join(this.cacheDir, "orig_" + filename);

            // Skip if final exists
            if (fs.existsSync(finalPath) && fs.statSync(finalPath).size > 0) continue;

            // Verified download
            if (!fs.existsSync(origPath) || fs.statSync(origPath).size === 0) {
                try {
                    await this.downloadRaw(item.image, origPath);
                    // Minimal delay
                    await new Promise(resolve => setTimeout(resolve, 500));

                    // UPDATE FRONTEND IMMEDIATELY
                    // We need to regenerate the display list
                    // Since we don't store full metadata in 'allCandidates', we might just assume 
                    // we can't easily regenerate 'processResults' output without the original 'data' object.
                    // Storing 'data' object globally? Or just fetch again?
                    // Re-fetching is bad.
                    // Solution: 'allCandidates' should contain full metadata? 
                    // Let's rely on the fact that if we just send the NEW file info? No, frontend expects full list.
                    // Hack: We need the full 'data' object to re-run processResults.
                    // Use 'this.lastData' if we save it.

                    if (this.lastData) {
                        const displayable = this.processResults(this.lastData);
                        this.sendSocketNotification("ARTWORK_DATA", displayable);
                    }

                } catch (e) {
                    console.error("MMM-Art: Failed to download raw " + filename, e);
                }
            }
        }

        // === PHASE 2: BATCH RESIZE ===
        console.log("MMM-Art: Phase 2 - Batch Resize");
        for (const item of allCandidates) {
            if (!item.image || !item.image.startsWith("http")) continue;

            const idPart = item.id.split("/").pop();
            let ext = path.extname(item.image) || ".jpg";
            if (ext.includes("?")) ext = ext.split("?")[0];
            const filename = `${idPart}${ext}`.replace(/%20/g, "_");

            const finalPath = path.join(this.cacheDir, filename);
            const origPath = path.join(this.cacheDir, "orig_" + filename);
            const lockPath = path.join(this.cacheDir, "lock_" + filename);

            if (fs.existsSync(finalPath) && fs.statSync(finalPath).size > 0) continue;

            if (!fs.existsSync(origPath)) continue;

            try {
                await this.resizeImage(origPath, finalPath, lockPath);

                // Update frontend
                if (this.lastData) {
                    const displayable = this.processResults(this.lastData);
                    this.sendSocketNotification("ARTWORK_DATA", displayable);
                }

                await new Promise(resolve => setTimeout(resolve, 2000));

            } catch (e) {
                console.error("MMM-Art: Error resizing " + filename, e);
            }
        }

        console.log("MMM-Art: Background caching loop finished.");
    }
});
