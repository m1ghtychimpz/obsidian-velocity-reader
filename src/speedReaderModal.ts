import { App, Modal } from "obsidian";
import { ParsedWord, ProcessedDocument } from "./textProcessor";
import type VelocityReaderPlugin from "./main";

export type ReadingMode = "rsvp" | "context" | "bionic";

interface CachedWordElement {
	container: HTMLElement;
	lead: HTMLElement;
	core: HTMLElement;
	trail: HTMLElement;
}

interface CachedBionicWordElement {
	container: HTMLElement;
	fixation: HTMLElement;
	rest: HTMLElement;
}

export class SpeedReaderModal extends Modal {
	plugin: VelocityReaderPlugin;
	readingDoc: ProcessedDocument;
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

	// Bionic Mode DOM Cache
	private cachedBionicChunkStartPara: number = -1;
	private cachedBionicChunkEndPara: number = -1;
	private cachedBionicWordElements: Map<number, CachedBionicWordElement> = new Map();
	private activeBionicWordElement: CachedBionicWordElement | null = null;

	// UI Elements
	private viewportContainer!: HTMLElement;
	private rsvpContainer!: HTMLElement;
	private rsvpPrefixEl!: HTMLElement;
	private rsvpOrpEl!: HTMLElement;
	private rsvpSuffixEl!: HTMLElement;

	private contextContainer!: HTMLElement;
	private contextContentEl!: HTMLElement;

	private bionicContainer!: HTMLElement;
	private bionicContentEl!: HTMLElement;

	private titleDocEl!: HTMLElement;
	private playPauseBtn!: HTMLButtonElement;
	private modeToggleBtn!: HTMLButtonElement;
	private speedSlider!: HTMLInputElement;
	private speedValueDisplay!: HTMLElement;
	private progressBarFill!: HTMLElement;
	private progressPercentDisplay!: HTMLElement;
	private progressPageDisplay!: HTMLElement;
	private progressTimeDisplay!: HTMLElement;

	private boundKeyDownHandler: (evt: KeyboardEvent) => void;

	constructor(app: App, plugin: VelocityReaderPlugin, readingDoc: ProcessedDocument, documentTitle: string = "Selection") {
		super(app);
		this.plugin = plugin;
		this.readingDoc = readingDoc;
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
		this.cachedBionicWordElements.clear();
		this.contentEl.empty();
	}

	/**
	 * Switches the active document inside the open modal
	 */
	public loadNewDocument(newDoc: ProcessedDocument, title: string = "Document"): void {
		this.pause();
		this.readingDoc = newDoc;
		this.documentTitle = title;
		this.currentIndex = 0;
		this.wordTimeElapsed = 0;
		this.cachedChunkStartPara = -1;
		this.cachedChunkEndPara = -1;
		this.cachedWordElements.clear();
		this.cachedBionicChunkStartPara = -1;
		this.cachedBionicChunkEndPara = -1;
		this.cachedBionicWordElements.clear();

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
			text: this.getModeButtonText(),
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

	private getModeButtonText(): string {
		if (this.mode === "rsvp") return "Mode: RSVP";
		if (this.mode === "context") return "Mode: Flow";
		return "Mode: Bionic";
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

		// --- Bionic Reading Container ---
		this.bionicContainer = this.viewportContainer.createDiv({
			cls: "velocity-bionic-viewport",
		});
		this.bionicContainer.style.fontSize = `${this.plugin.settings.bionicFontSize ?? 22}px`;

		this.bionicContentEl = this.bionicContainer.createDiv({
			cls: "velocity-bionic-content",
		});
	}

	private buildControls(parent: HTMLElement): void {
		const controlsBar = parent.createDiv({ cls: "velocity-controls-bar" });

		// Left Group: Navigation & Play/Pause
		const playbackGroup = controlsBar.createDiv({ cls: "velocity-control-group" });

		const prevPageBtn = playbackGroup.createEl("button", {
			cls: "velocity-btn velocity-btn-secondary velocity-btn-page",
			text: "⏮ Strana",
			attr: { "aria-label": "Predchádzajúca strana (PageUp alebo [ )" },
		});
		prevPageBtn.addEventListener("click", () => {
			this.prevPage();
			prevPageBtn.blur();
		});

		const skipBackBtn = playbackGroup.createEl("button", {
			cls: "velocity-btn velocity-btn-secondary",
			text: "◀ -10w",
			attr: { "aria-label": "Preskočiť späť o 10 slov (Šípka doľava)" },
		});
		skipBackBtn.addEventListener("click", () => {
			this.skipWords(-10);
			skipBackBtn.blur();
		});

		this.playPauseBtn = playbackGroup.createEl("button", {
			cls: "velocity-btn velocity-btn-primary velocity-btn-play",
			text: "▶ Play",
			attr: { "aria-label": "Spustiť / Pozastaviť (Medzerník)" },
		});
		this.playPauseBtn.addEventListener("click", () => {
			this.togglePlay();
			this.playPauseBtn.blur();
		});

		const skipFwdBtn = playbackGroup.createEl("button", {
			cls: "velocity-btn velocity-btn-secondary",
			text: "+10w ▶",
			attr: { "aria-label": "Preskočiť dopredu o 10 slov (Šípka doprava)" },
		});
		skipFwdBtn.addEventListener("click", () => {
			this.skipWords(10);
			skipFwdBtn.blur();
		});

		const nextPageBtn = playbackGroup.createEl("button", {
			cls: "velocity-btn velocity-btn-secondary velocity-btn-page",
			text: "Strana ⏭",
			attr: { "aria-label": "Ďalšia strana (PageDown alebo ] )" },
		});
		nextPageBtn.addEventListener("click", () => {
			this.nextPage();
			nextPageBtn.blur();
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
			const targetIndex = Math.floor(ratio * (this.readingDoc.words.length - 1));
			this.seekToWord(targetIndex);
		});

		const metaRow = progressWrapper.createDiv({ cls: "velocity-progress-meta" });
		this.progressPercentDisplay = metaRow.createSpan({
			cls: "velocity-meta-percent",
			text: "0%",
		});

		this.progressPageDisplay = metaRow.createSpan({
			cls: "velocity-meta-page",
			text: "Strana 1 / 1",
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
		if (this.readingDoc.words.length === 0) return;
		if (this.currentIndex >= this.readingDoc.words.length - 1) {
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

		const currentWord = this.readingDoc.words[this.currentIndex];
		const durationMs = this.calculateWordDurationMs(currentWord);

		if (this.wordTimeElapsed >= durationMs) {
			while (this.wordTimeElapsed >= durationMs && this.isPlaying) {
				this.wordTimeElapsed -= durationMs;
				this.currentIndex++;

				if (this.currentIndex >= this.readingDoc.words.length) {
					this.currentIndex = this.readingDoc.words.length - 1;
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
		this.rsvpContainer.addClass("is-hidden");
		this.contextContainer.addClass("is-hidden");
		this.bionicContainer.addClass("is-hidden");

		if (this.mode === "rsvp") {
			this.rsvpContainer.removeClass("is-hidden");
			this.modeToggleBtn.setText("Mode: RSVP");
		} else if (this.mode === "context") {
			this.contextContainer.removeClass("is-hidden");
			this.modeToggleBtn.setText("Mode: Flow");
			this.ensureContextChunkLoaded(this.currentIndex);
		} else if (this.mode === "bionic") {
			this.bionicContainer.removeClass("is-hidden");
			this.modeToggleBtn.setText("Mode: Bionic");
			this.ensureBionicChunkLoaded(this.currentIndex);
		}
	}

	public toggleMode(): void {
		if (this.mode === "rsvp") {
			this.mode = "context";
		} else if (this.mode === "context") {
			this.mode = "bionic";
		} else {
			this.mode = "rsvp";
		}
		this.applyMode();
		this.renderCurrentWord();
	}

	private renderCurrentWord(): void {
		const currentWord = this.readingDoc.words[this.currentIndex];
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
		} else if (this.mode === "context") {
			this.updateContextHighlighting(this.currentIndex);
		} else if (this.mode === "bionic") {
			this.updateBionicHighlighting(this.currentIndex);
		}
	}

	/**
	 * Smoothly scrolls the active reading word into view if it approaches the top/bottom viewport edges.
	 */
	private scrollWordIntoView(wordEl: HTMLElement, container: HTMLElement, forceCenter = false): void {
		if (!wordEl || !container) return;

		const cRect = container.getBoundingClientRect();
		const wRect = wordEl.getBoundingClientRect();

		// If container does not overflow vertically, no scrolling needed
		if (container.scrollHeight <= container.clientHeight) return;

		const buffer = 45;
		const isAbove = wRect.top < cRect.top + buffer;
		const isBelow = wRect.bottom > cRect.bottom - buffer;

		if (forceCenter || isAbove || isBelow) {
			const relativeTop = wRect.top - cRect.top;
			const targetScroll = container.scrollTop + relativeTop - (cRect.height / 2) + (wRect.height / 2);
			container.scrollTo({
				top: Math.max(0, targetScroll),
				behavior: forceCenter ? "auto" : "smooth",
			});
		}
	}

	private ensureContextChunkLoaded(wordIndex: number): void {
		const word = this.readingDoc.words[wordIndex];
		if (!word) return;

		const targetParaIdx = word.paragraphIndex;

		if (
			this.cachedChunkStartPara !== -1 &&
			targetParaIdx >= this.cachedChunkStartPara &&
			targetParaIdx <= this.cachedChunkEndPara
		) {
			return;
		}

		const pageSize = Math.max(1, this.paragraphsPerPage);
		const pageIndex = Math.floor(targetParaIdx / pageSize);
		const chunkStart = pageIndex * pageSize;
		const chunkEnd = Math.min(
			this.readingDoc.paragraphs.length - 1,
			chunkStart + pageSize - 1
		);

		this.cachedChunkStartPara = chunkStart;
		this.cachedChunkEndPara = chunkEnd;

		this.contextContentEl.empty();
		this.cachedWordElements.clear();
		this.activeWordElement = null;
		this.prevWordElement = null;
		this.nextWordElement = null;

		for (let p = chunkStart; p <= chunkEnd; p++) {
			const paragraph = this.readingDoc.paragraphs[p];
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

				wordSpan.addEventListener("click", () => {
					this.seekToWord(wObj.index);
				});

				this.cachedWordElements.set(wObj.index, {
					container: wordSpan,
					lead: leadSpan,
					core: coreSpan,
					trail: trailSpan,
				});
			}
		}

		this.contextContainer.scrollTop = 0;
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
			this.scrollWordIntoView(curr.container, this.contextContainer);
		}

		const next = this.cachedWordElements.get(activeIdx + 1);
		if (next) {
			next.container.addClass("is-next-word");
			this.nextWordElement = next;
		}
	}

	private ensureBionicChunkLoaded(wordIndex: number): void {
		const word = this.readingDoc.words[wordIndex];
		if (!word) return;

		const targetParaIdx = word.paragraphIndex;

		if (
			this.cachedBionicChunkStartPara !== -1 &&
			targetParaIdx >= this.cachedBionicChunkStartPara &&
			targetParaIdx <= this.cachedBionicChunkEndPara
		) {
			return;
		}

		const pageSize = Math.max(1, this.paragraphsPerPage);
		const pageIndex = Math.floor(targetParaIdx / pageSize);
		const chunkStart = pageIndex * pageSize;
		const chunkEnd = Math.min(
			this.readingDoc.paragraphs.length - 1,
			chunkStart + pageSize - 1
		);

		this.cachedBionicChunkStartPara = chunkStart;
		this.cachedBionicChunkEndPara = chunkEnd;

		this.bionicContentEl.empty();
		this.cachedBionicWordElements.clear();
		this.activeBionicWordElement = null;

		for (let p = chunkStart; p <= chunkEnd; p++) {
			const paragraph = this.readingDoc.paragraphs[p];
			if (!paragraph) continue;

			const pEl = this.bionicContentEl.createEl("p", {
				cls: "velocity-bionic-paragraph",
			});

			for (let w = 0; w < paragraph.words.length; w++) {
				const wObj = paragraph.words[w];

				const wordSpan = pEl.createSpan({
					cls: "velocity-bionic-word",
				});

				const fixation = wordSpan.createEl("b", {
					cls: "velocity-bionic-fixation",
					text: wObj.bionic.fixation,
				});

				const rest = wordSpan.createSpan({
					cls: "velocity-bionic-rest",
					text: wObj.bionic.rest,
				});

				pEl.appendText(" ");

				wordSpan.addEventListener("click", () => {
					this.seekToWord(wObj.index);
				});

				this.cachedBionicWordElements.set(wObj.index, {
					container: wordSpan,
					fixation,
					rest,
				});
			}
		}

		this.bionicContainer.scrollTop = 0;
	}

	private updateBionicHighlighting(activeIdx: number): void {
		this.ensureBionicChunkLoaded(activeIdx);

		if (this.activeBionicWordElement) {
			this.activeBionicWordElement.container.removeClass("is-active-bionic");
			this.activeBionicWordElement = null;
		}

		const curr = this.cachedBionicWordElements.get(activeIdx);
		if (curr) {
			curr.container.addClass("is-active-bionic");
			this.activeBionicWordElement = curr;
			this.scrollWordIntoView(curr.container, this.bionicContainer);
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

	public seekToWord(index: number, forceScrollTop = false): void {
		this.currentIndex = Math.max(0, Math.min(this.readingDoc.words.length - 1, index));
		this.wordTimeElapsed = 0;
		this.renderCurrentWord();
		this.updateProgressUi();

		if (forceScrollTop) {
			if (this.mode === "context" && this.contextContainer) {
				this.contextContainer.scrollTop = 0;
			} else if (this.mode === "bionic" && this.bionicContainer) {
				this.bionicContainer.scrollTop = 0;
			}
			return;
		}

		if (this.mode === "context" && this.activeWordElement) {
			this.scrollWordIntoView(this.activeWordElement.container, this.contextContainer, true);
		} else if (this.mode === "bionic" && this.activeBionicWordElement) {
			this.scrollWordIntoView(this.activeBionicWordElement.container, this.bionicContainer, true);
		}
	}

	public nextPage(): void {
		if (!this.readingDoc || this.readingDoc.paragraphs.length === 0) return;
		const currentWord = this.readingDoc.words[this.currentIndex];
		const currentPara = currentWord ? currentWord.paragraphIndex : 0;
		const pageSize = Math.max(1, this.paragraphsPerPage);
		const currentPage = Math.floor(currentPara / pageSize);
		const totalPages = Math.max(1, Math.ceil(this.readingDoc.paragraphs.length / pageSize));

		if (currentPage < totalPages - 1) {
			const targetPara = (currentPage + 1) * pageSize;
			const targetWord = this.readingDoc.paragraphs[targetPara]?.startWordIndex;
			if (targetWord !== undefined) {
				this.seekToWord(targetWord, true);
			}
		} else {
			this.seekToWord(this.readingDoc.words.length - 1);
		}
	}

	public prevPage(): void {
		if (!this.readingDoc || this.readingDoc.paragraphs.length === 0) return;
		const currentWord = this.readingDoc.words[this.currentIndex];
		const currentPara = currentWord ? currentWord.paragraphIndex : 0;
		const pageSize = Math.max(1, this.paragraphsPerPage);
		const currentPage = Math.floor(currentPara / pageSize);
		const currentParaStartWord = this.readingDoc.paragraphs[currentPage * pageSize]?.startWordIndex ?? 0;

		if (this.currentIndex > currentParaStartWord + 3) {
			this.seekToWord(currentParaStartWord, true);
		} else if (currentPage > 0) {
			const targetPara = (currentPage - 1) * pageSize;
			const targetWord = this.readingDoc.paragraphs[targetPara]?.startWordIndex ?? 0;
			this.seekToWord(targetWord, true);
		} else {
			this.seekToWord(0, true);
		}
	}

	public skipWords(count: number): void {
		if (count < 0) {
			let target = this.currentIndex + count;
			for (let i = this.currentIndex - 1; i >= Math.max(0, this.currentIndex + count); i--) {
				if (this.readingDoc.words[i]?.isSentenceEnd) {
					target = i + 1;
					break;
				}
			}
			this.seekToWord(Math.max(0, target));
		} else {
			let target = this.currentIndex + count;
			for (let i = this.currentIndex; i < Math.min(this.readingDoc.words.length, this.currentIndex + count); i++) {
				if (this.readingDoc.words[i]?.isSentenceEnd) {
					target = i + 1;
					break;
				}
			}
			this.seekToWord(Math.min(this.readingDoc.words.length - 1, target));
		}
	}

	private updateProgressUi(): void {
		const total = this.readingDoc.words.length;
		if (total === 0) return;

		const pct = Math.round(((this.currentIndex + 1) / total) * 100);
		this.progressBarFill.style.width = `${pct}%`;
		this.progressPercentDisplay.setText(`${pct}% (${this.currentIndex + 1}/${total} slov)`);

		const currentWord = this.readingDoc.words[this.currentIndex];
		const currentPara = currentWord ? currentWord.paragraphIndex : 0;
		const pageSize = Math.max(1, this.paragraphsPerPage);
		const currentPage = Math.floor(currentPara / pageSize) + 1;
		const totalPages = Math.max(1, Math.ceil(this.readingDoc.paragraphs.length / pageSize));

		if (this.progressPageDisplay) {
			this.progressPageDisplay.setText(`Strana ${currentPage} / ${totalPages}`);
		}

		let remainingMs = 0;
		const baseMs = (60 / this.currentWpm) * 1000;
		for (let i = this.currentIndex; i < total; i++) {
			const w = this.readingDoc.words[i];
			remainingMs += this.smartMicroPauses ? baseMs * w.pauseMultiplier : baseMs;
		}

		const totalSeconds = Math.ceil(remainingMs / 1000);
		const mins = Math.floor(totalSeconds / 60);
		const secs = totalSeconds % 60;
		const formattedSecs = secs < 10 ? `0${secs}` : `${secs}`;

		if (mins > 0) {
			this.progressTimeDisplay.setText(`${mins}m ${formattedSecs}s zostáva`);
		} else {
			this.progressTimeDisplay.setText(`${formattedSecs}s zostáva`);
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
			case "PageUp":
			case "BracketLeft":
				evt.preventDefault();
				this.prevPage();
				break;
			case "PageDown":
			case "BracketRight":
				evt.preventDefault();
				this.nextPage();
				break;
			case "Escape":
				evt.preventDefault();
				this.close();
				break;
		}
	}
}
