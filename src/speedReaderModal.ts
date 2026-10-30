import { App, Modal } from "obsidian";
import { ParsedWord, ProcessedDocument } from "./textProcessor";
import type VelocityReaderPlugin from "./main";

export type ReadingMode = "rsvp" | "context";

interface CachedWordElement {
	container: HTMLElement;
	lead: HTMLElement;
	core: HTMLElement;
	trail: HTMLElement;
}

export class SpeedReaderModal extends Modal {
	plugin: VelocityReaderPlugin;
	doc: ProcessedDocument;
	documentTitle: string;

	// State
	currentIndex: number = 0;
	isPlaying: boolean = false;
	currentWpm: number;
	mode: ReadingMode;
	smartMicroPauses: boolean;
	paragraphsPerPage: number;

	// Timing Engine
	private rafId: number | null = null;
	private lastFrameTime: number = 0;
	private wordTimeElapsed: number = 0;

	// Context Mode DOM Cache
	private cachedChunkStartPara: number = -1;
	private cachedChunkEndPara: number = -1;
	private cachedWordElements: Map<number, CachedWordElement> = new Map();
	private activeWordElement: CachedWordElement | null = null;
	private prevWordElement: CachedWordElement | null = null;
	private nextWordElement: CachedWordElement | null = null;

	// UI Elements
	private viewportContainer!: HTMLElement;
	private rsvpContainer!: HTMLElement;
	private rsvpPrefixEl!: HTMLElement;
	private rsvpOrpEl!: HTMLElement;
	private rsvpSuffixEl!: HTMLElement;

	private contextContainer!: HTMLElement;
	private contextContentEl!: HTMLElement;

	private titleDocEl!: HTMLElement;
	private playPauseBtn!: HTMLButtonElement;
	private modeToggleBtn!: HTMLButtonElement;
	private speedSlider!: HTMLInputElement;
	private speedValueDisplay!: HTMLElement;
	private progressBarFill!: HTMLElement;
	private progressPercentDisplay!: HTMLElement;
	private progressTimeDisplay!: HTMLElement;

	private boundKeyDownHandler: (evt: KeyboardEvent) => void;

	constructor(app: App, plugin: VelocityReaderPlugin, doc: ProcessedDocument, documentTitle: string = "Selection") {
		super(app);
		this.plugin = plugin;
		this.doc = doc;
		this.documentTitle = documentTitle;
		this.currentWpm = this.plugin.settings.defaultWpm;
		this.mode = this.plugin.settings.defaultMode;
		this.smartMicroPauses = this.plugin.settings.smartMicroPauses;
		this.paragraphsPerPage = this.plugin.settings.paragraphsPerPage;

		this.boundKeyDownHandler = this.handleKeyDown.bind(this);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.modalEl.addClass("velocity-reader-modal");

		this.buildHeader(contentEl);
		this.buildViewport(contentEl);
		this.buildControls(contentEl);
		this.buildProgressBar(contentEl);

		window.addEventListener("keydown", this.boundKeyDownHandler, true);

		// Initial display render
		this.applyMode();
		this.renderCurrentWord();
		this.updateProgressUi();
	}

	onClose(): void {
		this.pause();
		window.removeEventListener("keydown", this.boundKeyDownHandler, true);
		this.cachedWordElements.clear();
		this.contentEl.empty();
	}

	/**
	 * Switches the active document inside the open modal
	 */
	public loadNewDocument(newDoc: ProcessedDocument, title: string = "Document"): void {
		this.pause();
		this.doc = newDoc;
		this.documentTitle = title;
		this.currentIndex = 0;
		this.wordTimeElapsed = 0;
		this.cachedChunkStartPara = -1;
		this.cachedChunkEndPara = -1;
		this.cachedWordElements.clear();

		if (this.titleDocEl) {
			this.titleDocEl.setText(this.documentTitle);
		}

		this.applyMode();
		this.renderCurrentWord();
		this.updateProgressUi();
	}

	// ==========================================
	// UI BUILDERS
	// ==========================================

	private buildHeader(parent: HTMLElement): void {
		const header = parent.createDiv({ cls: "velocity-header" });

		const titleLeft = header.createDiv({ cls: "velocity-title-container" });
		titleLeft.createSpan({ text: "Velocity Reader", cls: "velocity-title-brand" });
		this.titleDocEl = titleLeft.createSpan({
			text: this.documentTitle,
			cls: "velocity-title-doc",
		});

		const rightControls = header.createDiv({ cls: "velocity-header-right" });

		// Choose note button (allows picking any file from vault)
		const chooseNoteBtn = rightControls.createEl("button", {
			cls: "velocity-btn velocity-btn-choose-note",
			text: "📂 Choose Note",
			attr: { "aria-label": "Select another note to read" },
		});
		chooseNoteBtn.addEventListener("click", () => {
			this.pause();
			this.plugin.promptChooseNoteAndRead((file, processedDoc) => {
				this.loadNewDocument(processedDoc, file.basename);
			});
			chooseNoteBtn.blur();
		});

		this.modeToggleBtn = rightControls.createEl("button", {
			cls: "velocity-btn velocity-btn-mode",
			text: this.mode === "rsvp" ? "Mode: RSVP" : "Mode: Flow",
		});
		this.modeToggleBtn.addEventListener("click", () => {
			this.toggleMode();
			this.modeToggleBtn.blur();
		});

		const closeBtn = rightControls.createEl("button", {
			cls: "velocity-btn velocity-btn-icon velocity-btn-close",
			text: "✕",
			attr: { "aria-label": "Close reader" },
		});
		closeBtn.addEventListener("click", () => this.close());
	}

	private buildViewport(parent: HTMLElement): void {
		this.viewportContainer = parent.createDiv({ cls: "velocity-viewport" });

		// --- RSVP Container ---
		this.rsvpContainer = this.viewportContainer.createDiv({
			cls: "velocity-rsvp-viewport",
		});
		this.rsvpContainer.style.fontSize = `${this.plugin.settings.rsvpFontSize}px`;

		// Fixed Reticle lines (Top and Bottom ticks for optimal eye anchoring)
		const topReticle = this.rsvpContainer.createDiv({ cls: "velocity-reticle velocity-reticle-top" });
		topReticle.createDiv({ cls: "velocity-reticle-marker" });

		const wordRow = this.rsvpContainer.createDiv({ cls: "velocity-rsvp-word-row" });
		this.rsvpPrefixEl = wordRow.createSpan({ cls: "velocity-orp-prefix" });
		this.rsvpOrpEl = wordRow.createSpan({ cls: "velocity-orp-char" });
		this.rsvpOrpEl.style.color = this.plugin.settings.orpAccentColor;
		this.rsvpSuffixEl = wordRow.createSpan({ cls: "velocity-orp-suffix" });

		const bottomReticle = this.rsvpContainer.createDiv({ cls: "velocity-reticle velocity-reticle-bottom" });
		bottomReticle.createDiv({ cls: "velocity-reticle-marker" });

		// --- Contextual Flow Container ---
		this.contextContainer = this.viewportContainer.createDiv({
			cls: "velocity-context-viewport",
		});
		this.contextContainer.style.fontSize = `${this.plugin.settings.contextFontSize}px`;

		this.contextContentEl = this.contextContainer.createDiv({
			cls: "velocity-context-content",
		});
	}

	private buildControls(parent: HTMLElement): void {
		const controlsBar = parent.createDiv({ cls: "velocity-controls-bar" });

		// Left Group: Navigation & Play/Pause
		const playbackGroup = controlsBar.createDiv({ cls: "velocity-control-group" });

		const skipBackBtn = playbackGroup.createEl("button", {
			cls: "velocity-btn velocity-btn-secondary",
			text: "⏮ -10w",
			attr: { "aria-label": "Skip backward 10 words or sentence (Left Arrow)" },
		});
		skipBackBtn.addEventListener("click", () => {
			this.skipWords(-10);
			skipBackBtn.blur();
		});

		this.playPauseBtn = playbackGroup.createEl("button", {
			cls: "velocity-btn velocity-btn-primary velocity-btn-play",
			text: "▶ Play",
			attr: { "aria-label": "Toggle playback (Spacebar)" },
		});
		this.playPauseBtn.addEventListener("click", () => {
			this.togglePlay();
			this.playPauseBtn.blur();
		});

		const skipFwdBtn = playbackGroup.createEl("button", {
			cls: "velocity-btn velocity-btn-secondary",
			text: "+10w ⏭",
			attr: { "aria-label": "Skip forward 10 words or sentence (Right Arrow)" },
		});
		skipFwdBtn.addEventListener("click", () => {
			this.skipWords(10);
			skipFwdBtn.blur();
		});

		// Right Group: Speed Slider and Numeric Readout
		const speedGroup = controlsBar.createDiv({ cls: "velocity-control-group velocity-speed-group" });

		const speedLabel = speedGroup.createEl("label", {
			text: "Speed:",
			cls: "velocity-speed-label",
		});

		this.speedSlider = speedGroup.createEl("input", {
			type: "range",
			cls: "velocity-slider",
			attr: {
				min: "50",
				max: "3000",
				step: "25",
				value: this.currentWpm.toString(),
			},
		});

		this.speedValueDisplay = speedGroup.createSpan({
			cls: "velocity-speed-value",
			text: `${this.currentWpm} WPM`,
		});

		this.syncSliderStyle();
		this.speedSlider.addEventListener("input", () => {
			this.setWpm(parseInt(this.speedSlider.value, 10));
		});
	}

	private buildProgressBar(parent: HTMLElement): void {
		const progressWrapper = parent.createDiv({ cls: "velocity-progress-wrapper" });

		const track = progressWrapper.createDiv({ cls: "velocity-progress-track" });
		this.progressBarFill = track.createDiv({ cls: "velocity-progress-fill" });

		track.addEventListener("click", (evt: MouseEvent) => {
			const rect = track.getBoundingClientRect();
			const ratio = Math.max(0, Math.min(1, (evt.clientX - rect.left) / rect.width));
			const targetIndex = Math.floor(ratio * (this.doc.words.length - 1));
			this.seekToWord(targetIndex);
		});

		const metaRow = progressWrapper.createDiv({ cls: "velocity-progress-meta" });
		this.progressPercentDisplay = metaRow.createSpan({
			cls: "velocity-meta-percent",
			text: "0%",
		});

		this.progressTimeDisplay = metaRow.createSpan({
			cls: "velocity-meta-time",
			text: "--:-- remaining",
		});
	}

	// ==========================================
	// TIMING ENGINE & PLAYBACK LOOP
	// ==========================================

	private play(): void {
		if (this.doc.words.length === 0) return;
		if (this.currentIndex >= this.doc.words.length - 1) {
			this.currentIndex = 0;
		}

		this.isPlaying = true;
		this.playPauseBtn.setText("⏸ Pause");
		this.playPauseBtn.addClass("is-playing");
		this.lastFrameTime = performance.now();
		this.wordTimeElapsed = 0;

		this.rafId = requestAnimationFrame(this.onAnimationTick.bind(this));
	}

	private pause(): void {
		this.isPlaying = false;
		if (this.rafId !== null) {
			cancelAnimationFrame(this.rafId);
			this.rafId = null;
		}
		if (this.playPauseBtn) {
			this.playPauseBtn.setText("▶ Play");
			this.playPauseBtn.removeClass("is-playing");
		}
	}

	private togglePlay(): void {
		if (this.isPlaying) {
			this.pause();
		} else {
			this.play();
		}
	}

	private onAnimationTick(now: number): void {
		if (!this.isPlaying) return;

		const deltaMs = now - this.lastFrameTime;
		this.lastFrameTime = now;
		this.wordTimeElapsed += deltaMs;

		const currentWord = this.doc.words[this.currentIndex];
		const durationMs = this.calculateWordDurationMs(currentWord);

		if (this.wordTimeElapsed >= durationMs) {
			while (this.wordTimeElapsed >= durationMs && this.isPlaying) {
				this.wordTimeElapsed -= durationMs;
				this.currentIndex++;

				if (this.currentIndex >= this.doc.words.length) {
					this.currentIndex = this.doc.words.length - 1;
					this.pause();
					this.renderCurrentWord();
					this.updateProgressUi();
					return;
				}
			}

			this.renderCurrentWord();
			this.updateProgressUi();
		}

		this.rafId = requestAnimationFrame(this.onAnimationTick.bind(this));
	}

	private calculateWordDurationMs(word: ParsedWord | undefined): number {
		if (!word) return 100;
		const baseMs = (60 / this.currentWpm) * 1000;
		if (this.smartMicroPauses) {
			return baseMs * word.pauseMultiplier;
		}
		return baseMs;
	}

	// ==========================================
	// RENDERING & DOM CACHING
	// ==========================================

	private applyMode(): void {
		if (this.mode === "rsvp") {
			this.rsvpContainer.removeClass("is-hidden");
			this.contextContainer.addClass("is-hidden");
			this.modeToggleBtn.setText("Mode: RSVP");
		} else {
			this.rsvpContainer.addClass("is-hidden");
			this.contextContainer.removeClass("is-hidden");
			this.modeToggleBtn.setText("Mode: Flow");
			this.ensureContextChunkLoaded(this.currentIndex);
		}
	}

	public toggleMode(): void {
		this.mode = this.mode === "rsvp" ? "context" : "rsvp";
		this.applyMode();
		this.renderCurrentWord();
	}

	private renderCurrentWord(): void {
		const currentWord = this.doc.words[this.currentIndex];
		if (!currentWord) {
			this.rsvpPrefixEl.setText("");
			this.rsvpOrpEl.setText("");
			this.rsvpSuffixEl.setText("");
			return;
		}

		if (this.mode === "rsvp") {
			this.rsvpPrefixEl.setText(currentWord.orp.prefix);
			this.rsvpOrpEl.setText(currentWord.orp.orpChar);
			this.rsvpSuffixEl.setText(currentWord.orp.suffix);
		} else {
			this.updateContextHighlighting(this.currentIndex);
		}
	}

	private ensureContextChunkLoaded(wordIndex: number): void {
		const word = this.doc.words[wordIndex];
		if (!word) return;

		const targetParaIdx = word.paragraphIndex;

		if (
			this.cachedChunkStartPara !== -1 &&
			targetParaIdx >= this.cachedChunkStartPara &&
			targetParaIdx <= this.cachedChunkEndPara
		) {
			return;
		}

		const chunkStart = targetParaIdx;
		const chunkEnd = Math.min(
			this.doc.paragraphs.length - 1,
			chunkStart + this.paragraphsPerPage - 1
		);

		this.cachedChunkStartPara = chunkStart;
		this.cachedChunkEndPara = chunkEnd;

		this.contextContentEl.empty();
		this.cachedWordElements.clear();
		this.activeWordElement = null;
		this.prevWordElement = null;
		this.nextWordElement = null;

		for (let p = chunkStart; p <= chunkEnd; p++) {
			const paragraph = this.doc.paragraphs[p];
			if (!paragraph) continue;

			const pEl = this.contextContentEl.createEl("p", {
				cls: "velocity-context-paragraph",
			});

			for (let w = 0; w < paragraph.words.length; w++) {
				const wObj = paragraph.words[w];

				const wordSpan = pEl.createSpan({
					cls: "velocity-context-word",
				});

				const leadSpan = wordSpan.createSpan({
					cls: "velocity-sub-lead",
					text: wObj.saccadic.leadChars,
				});

				const coreSpan = wordSpan.createSpan({
					cls: "velocity-sub-core",
					text: wObj.saccadic.coreChars,
				});

				const trailSpan = wordSpan.createSpan({
					cls: "velocity-sub-trail",
					text: wObj.saccadic.trailChars,
				});

				pEl.appendText(" ");

				this.cachedWordElements.set(wObj.index, {
					container: wordSpan,
					lead: leadSpan,
					core: coreSpan,
					trail: trailSpan,
				});
			}
		}
	}

	private updateContextHighlighting(activeIdx: number): void {
		this.ensureContextChunkLoaded(activeIdx);

		if (this.prevWordElement) {
			this.prevWordElement.container.removeClass("is-prev-word");
			this.prevWordElement = null;
		}
		if (this.activeWordElement) {
			this.activeWordElement.container.removeClass("is-active-word");
			this.activeWordElement = null;
		}
		if (this.nextWordElement) {
			this.nextWordElement.container.removeClass("is-next-word");
			this.nextWordElement = null;
		}

		const prev = this.cachedWordElements.get(activeIdx - 1);
		if (prev) {
			prev.container.addClass("is-prev-word");
			this.prevWordElement = prev;
		}

		const curr = this.cachedWordElements.get(activeIdx);
		if (curr) {
			curr.container.addClass("is-active-word");
			this.activeWordElement = curr;
		}

		const next = this.cachedWordElements.get(activeIdx + 1);
		if (next) {
			next.container.addClass("is-next-word");
			this.nextWordElement = next;
		}
	}

	// ==========================================
	// NAVIGATION & SEEKING
	// ==========================================

	public setWpm(newWpm: number): void {
		this.currentWpm = Math.max(50, Math.min(3000, newWpm));
		this.speedSlider.value = this.currentWpm.toString();
		this.speedValueDisplay.setText(`${this.currentWpm} WPM`);
		this.syncSliderStyle();
		this.updateProgressUi();
	}

	public adjustWpm(delta: number): void {
		this.setWpm(this.currentWpm + delta);
	}

	public seekToWord(index: number): void {
		this.currentIndex = Math.max(0, Math.min(this.doc.words.length - 1, index));
		this.wordTimeElapsed = 0;
		this.renderCurrentWord();
		this.updateProgressUi();
	}

	public skipWords(count: number): void {
		if (count < 0) {
			let target = this.currentIndex + count;
			for (let i = this.currentIndex - 1; i >= Math.max(0, this.currentIndex + count); i--) {
				if (this.doc.words[i]?.isSentenceEnd) {
					target = i + 1;
					break;
				}
			}
			this.seekToWord(Math.max(0, target));
		} else {
			let target = this.currentIndex + count;
			for (let i = this.currentIndex; i < Math.min(this.doc.words.length, this.currentIndex + count); i++) {
				if (this.doc.words[i]?.isSentenceEnd) {
					target = i + 1;
					break;
				}
			}
			this.seekToWord(Math.min(this.doc.words.length - 1, target));
		}
	}

	private updateProgressUi(): void {
		const total = this.doc.words.length;
		if (total === 0) return;

		const pct = Math.round(((this.currentIndex + 1) / total) * 100);
		this.progressBarFill.style.width = `${pct}%`;
		this.progressPercentDisplay.setText(`${pct}% (${this.currentIndex + 1}/${total} words)`);

		let remainingMs = 0;
		const baseMs = (60 / this.currentWpm) * 1000;
		for (let i = this.currentIndex; i < total; i++) {
			const w = this.doc.words[i];
			remainingMs += this.smartMicroPauses ? baseMs * w.pauseMultiplier : baseMs;
		}

		const totalSeconds = Math.ceil(remainingMs / 1000);
		const mins = Math.floor(totalSeconds / 60);
		const secs = totalSeconds % 60;
		const formattedSecs = secs < 10 ? `0${secs}` : `${secs}`;

		if (mins > 0) {
			this.progressTimeDisplay.setText(`${mins}m ${formattedSecs}s remaining`);
		} else {
			this.progressTimeDisplay.setText(`${formattedSecs}s remaining`);
		}
	}

	private syncSliderStyle(): void {
		const min = parseFloat(this.speedSlider.min) || 50;
		const max = parseFloat(this.speedSlider.max) || 3000;
		const val = parseFloat(this.speedSlider.value) || 300;
		const progress = ((val - min) / (max - min)) * 100;
		this.speedSlider.style.setProperty("--slider-progress", `${progress}%`);
	}

	// ==========================================
	// KEYBOARD SHORTCUTS
	// ==========================================

	private handleKeyDown(evt: KeyboardEvent): void {
		if (evt.ctrlKey || evt.altKey || evt.metaKey) return;

		switch (evt.code) {
			case "Space":
				evt.preventDefault();
				this.togglePlay();
				break;
			case "KeyM":
			case "Tab":
				evt.preventDefault();
				this.toggleMode();
				break;
			case "ArrowUp":
				evt.preventDefault();
				this.adjustWpm(25);
				break;
			case "ArrowDown":
				evt.preventDefault();
				this.adjustWpm(-25);
				break;
			case "ArrowLeft":
				evt.preventDefault();
				this.skipWords(-10);
				break;
			case "ArrowRight":
				evt.preventDefault();
				this.skipWords(10);
				break;
			case "Escape":
				evt.preventDefault();
				this.close();
				break;
		}
	}
}
