Module.register("MMM-Art", {
    defaults: {
        artworkList: ['Q15461864'], // Default: The Night Watch
        activeDuration: 30 * 1000, // 30 seconds
        inactiveDuration: 30 * 1000, // 30 seconds
        animationSpeed: 1000,
        showMetadata: true,
        slideChangeThreshold: 3, // How many times to show the same slide before changing
    },

    start: function () {
        this.artData = [];
        this.currentIndex = 0;
        this.slideShowCount = 0;
        this.timer = null;
        this.clockTimer = null;
        this.state = 'inactive'; // 'active' (showing art) or 'inactive' (hidden)
        this.wrapper = null;
        this.artContainer = null;
        this.clockWrapper = null;
        this.timeElement = null;
        this.dateElement = null;

        this.sendSocketNotification("LOG", "MMM-Art module started.");

        // Send screen resolution to helper
        const width = window.screen.width;
        const height = window.screen.height;
        this.sendSocketNotification("RESOLUTION", { width: width, height: height });

        // Start clock update
        this.clockTimer = setInterval(() => {
            this.updateClock();
        }, 1000);
    },

    getStyles: function () {
        return ["MMM-Art.css"];
    },

    getDom: function () {
        this.wrapper = document.createElement("div");
        this.wrapper.className = "MMM-Art-fullscreen";
        // Opacity controlled by toggleState

        // Clock Container
        this.clockWrapper = document.createElement("div");
        this.clockWrapper.className = "MMM-Art-clock";

        this.timeElement = document.createElement("div");
        this.timeElement.className = "MMM-Art-time";

        this.dateElement = document.createElement("div");
        this.dateElement.className = "MMM-Art-date";

        this.clockWrapper.appendChild(this.timeElement);
        this.clockWrapper.appendChild(this.dateElement);
        this.wrapper.appendChild(this.clockWrapper);

        // Art Container (so we don't clear the clock on render)
        this.artContainer = document.createElement("div");
        this.artContainer.className = "MMM-Art-container";
        this.artContainer.style.width = "100%";
        this.artContainer.style.height = "100%";
        this.artContainer.style.display = "flex";
        this.artContainer.style.justifyContent = "center";
        this.artContainer.style.alignItems = "center";
        this.wrapper.appendChild(this.artContainer);

        // Initial clock render
        this.updateClock();

        // If we have data and are active, populate
        if (this.state === 'active' && this.artData.length > 0) {
            this.renderCurrentArt();
        }

        return this.wrapper;
    },

    updateClock: function () {
        if (!this.timeElement || !this.dateElement) return;

        const now = new Date();

        // Time: 12:45
        const hours = now.getHours().toString().padStart(2, '0');
        const minutes = now.getMinutes().toString().padStart(2, '0');
        this.timeElement.innerText = `${hours}:${minutes}`;

        // Date: Saturday, January 24
        const options = { weekday: 'long', month: 'long', day: 'numeric' };
        this.dateElement.innerText = now.toLocaleDateString(this.config.locale || 'en-US', options);
    },

    renderCurrentArt: function () {
        if (!this.wrapper) return;

        try {
            const art = this.artData[this.currentIndex];
            this.sendSocketNotification("LOG", "Rendering art index " + this.currentIndex + ": " + JSON.stringify(art));

            if (!art) {
                this.sendSocketNotification("LOG", "Error: artData item at index " + this.currentIndex + " is undefined.");
                return;
            }

            // Clear previous content
            if (this.artContainer) {
                this.artContainer.innerHTML = "";
            } else {
                this.sendSocketNotification("LOG", "Error: artContainer is null, cannot render.");
                return;
            }

            // Image
            const img = document.createElement("img");
            img.className = "MMM-Art-image";
            img.src = art.image;
            this.artContainer.appendChild(img);

            // Metadata Overlay
            if (this.config.showMetadata) {
                const info = document.createElement("div");
                info.className = "MMM-Art-info";

                const title = document.createElement("div");
                title.className = "MMM-Art-title";
                title.innerText = art.title || "Untitled";
                info.appendChild(title);

                const artist = document.createElement("div");
                artist.className = "MMM-Art-artist";
                // Format artist with dates if available: "Rembrandt (1606–1669)"
                let artistText = art.artist || "Unknown Artist";
                if (art.artistBirth || art.artistDeath) {
                    artistText += ` (${art.artistBirth ? new Date(art.artistBirth).getFullYear() : '?'}–${art.artistDeath ? new Date(art.artistDeath).getFullYear() : '?'})`;
                }
                artist.innerText = artistText;
                info.appendChild(artist);

                const details = document.createElement("div");
                details.className = "MMM-Art-details";
                let detailsText = [];
                if (art.date) detailsText.push(new Date(art.date).getFullYear());
                if (art.collection) detailsText.push(art.collection);
                details.innerText = detailsText.join(" • ");
                info.appendChild(details);

                if (art.description) {
                    const desc = document.createElement("div");
                    desc.className = "MMM-Art-description";
                    desc.innerText = art.description;
                    info.appendChild(desc);
                }

                this.artContainer.appendChild(info);
            }
        } catch (e) {
            this.sendSocketNotification("LOG", "RENDER ERROR: " + e.message);
            console.error(e);
        }
    },

    notificationReceived: function (notification, payload, sender) {
        if (notification === "DOM_OBJECTS_CREATED") {
            this.sendSocketNotification("LOG", "DOM_OBJECTS_CREATED received. Waiting 5s before fetch...");
            setTimeout(() => {
                this.sendSocketNotification("LOG", "Sending FETCH_ARTWORK request now.");
                this.sendSocketNotification("FETCH_ARTWORK", this.config.artworkList);
            }, 5000);
        }
    },

    socketNotificationReceived: function (notification, payload) {
        if (notification === "ARTWORK_DATA") {
            this.artData = payload;
            this.sendSocketNotification("LOG", "ARTWORK_DATA received. Count: " + this.artData.length);
            if (this.artData.length > 0) {
                this.sendSocketNotification("LOG", "Data ready. Scheduling immediate toggle.");
                // Force immediate execution for debugging
                this.toggleState();
            } else {
                this.sendSocketNotification("LOG", "No artwork data received.");
            }
        }
    },

    scheduleToggle: function () {
        // Clear any existing timer
        if (this.timer) clearTimeout(this.timer);

        const nextInterval = this.state === 'active' ? this.config.activeDuration : this.config.inactiveDuration;

        this.timer = setTimeout(() => {
            this.toggleState();
        }, nextInterval);
    },

    toggleState: function () {
        this.sendSocketNotification("LOG", "toggleState EXEC [Start]. Current State: " + this.state);

        if (!this.wrapper) {
            this.sendSocketNotification("LOG", "CRITICAL: this.wrapper is NULL in toggleState!");
        } else {
            this.sendSocketNotification("LOG", "wrapper exists. Classes: " + this.wrapper.className);
        }

        if (this.state === 'inactive') {
            // Switch to ACTIVE (Show Art)
            this.state = 'active';

            // Check if we should change slide
            this.slideShowCount++;
            if (this.slideShowCount > this.config.slideChangeThreshold) {
                this.currentIndex = (this.currentIndex + 1) % this.artData.length;
                this.slideShowCount = 0;
            }
            // else: keep same index

            if (this.wrapper) {
                this.wrapper.classList.add("visible");
                this.wrapper.style.opacity = "1";
            }

            // Render content
            this.sendSocketNotification("LOG", "toggleState: Calling renderCurrentArt...");
            this.renderCurrentArt();
            this.sendSocketNotification("LOG", "toggleState: renderCurrentArt finished.");

            // Use MM method to hide others. 
            // Hide others
            try {
                this.sendSocketNotification("LOG", "toggleState: Hiding other modules...");
                const self = this;
                MM.getModules().exceptModule(this).enumerate(function (module) {
                    try {
                        // Log using identifier if available, or just index/safely
                        // self.sendSocketNotification("LOG", "Hiding module: " + (module ? module.name : "UNKNOWN")); 
                        module.hide(1000);
                    } catch (e) {
                        self.sendSocketNotification("LOG", "Error hiding module " + (module ? module.identifier : "UNKNOWN") + ": " + e.message);
                    }
                });
                this.sendSocketNotification("LOG", "toggleState: Other modules hidden.");
            } catch (err) {
                this.sendSocketNotification("LOG", "CRITICAL ERROR hiding modules: " + err.message);
            }

            // Make self visible
            if (this.wrapper) {
                this.sendSocketNotification("LOG", "State set to ACTIVE. Showing art: " + (this.artData[this.currentIndex].title || "Untitled"));
            }

        } else {
            // Switch to INACTIVE (Hide Art, Show Others)
            this.state = 'inactive';

            // Hide self
            if (this.wrapper) {
                this.wrapper.classList.remove("visible");
                this.wrapper.style.opacity = "0";
                this.sendSocketNotification("LOG", "State set to INACTIVE. Hiding art.");
            }

            // Show others
            try {
                const self = this;
                MM.getModules().exceptModule(this).enumerate(function (module) {
                    try {
                        // self.sendSocketNotification("LOG", "Showing module: " + (module ? module.name : "UNKNOWN"));
                        module.show(1000);
                    } catch (e) {
                        self.sendSocketNotification("LOG", "Error showing module " + (module ? module.identifier : "UNKNOWN") + ": " + e.message);
                    }
                });
            } catch (err) {
                this.sendSocketNotification("LOG", "CRITICAL ERROR showing modules: " + err.message);
            }
        }

        this.scheduleToggle();
    }
});
