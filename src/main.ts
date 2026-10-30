import {
	App,
	Editor,
	FuzzySuggestModal,
	MarkdownView,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
} from "obsidian";
import { SpeedReaderModal, ReadingMode } from "./speedReaderModal";
import { processText, ProcessedDocument } from "./textProcessor";

export interface VelocityReaderSettings {
	defaultWpm: number;
	defaultMode: ReadingMode;
	rsvpFontSize: number;
	contextFontSize: number;
	orpAccentColor: string;
	smartMicroPauses: boolean;
	paragraphsPerPage: number;
}

export const DEFAULT_SETTINGS: VelocityReaderSettings = {
	defaultWpm: 350,
	defaultMode: "rsvp",
	rsvpFontSize: 48,
	contextFontSize: 22,
	orpAccentColor: "#e06c75",
	smartMicroPauses: true,
	paragraphsPerPage: 2,
};

export class NoteSuggestModal extends FuzzySuggestModal<TFile> {
	onChooseFile: (file: TFile) => void;

	constructor(app: App, onChooseFile: (file: TFile) => void) {
		super(app);
		this.onChooseFile = onChooseFile;
		this.setPlaceholder("Vyberte alebo vyhľadajte poznámku na rýchle čítanie...");
	}

	getItems(): TFile[] {
		const mdFiles = this.app.vault.getMarkdownFiles();
		if (mdFiles && mdFiles.length > 0) {
			return mdFiles.sort((a, b) => a.path.localeCompare(b.path));
		}
		return this.app.vault.getFiles()
			.filter((f) => ["md", "markdown", "txt"].includes(f.extension.toLowerCase()))
			.sort((a, b) => a.path.localeCompare(b.path));
	}

	getItemText(file: TFile): string {
		return file.path;
	}

	onChooseItem(file: TFile, _evt: MouseEvent | KeyboardEvent): void {
		this.onChooseFile(file);
	}
}

export default class VelocityReaderPlugin extends Plugin {
	settings: VelocityReaderSettings = DEFAULT_SETTINGS;

	async onload(): Promise<void> {
		await this.loadSettings();

		// 1. Ribbon Icon on the left sidebar (with speedometer/gauge icon)
		this.addRibbonIcon("gauge", "Velocity Reader", (_evt: MouseEvent) => {
			this.handleRibbonClick();
		});

		// 2. Editor Command: Speed Read Selected Text or Active Note
		this.addCommand({
			id: "velocity-speed-read-selected",
			name: "Speed Read Selected Text or Active Note",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				this.launchReaderFromEditor(editor, view);
			},
		});

		// 3. Command: Choose Note from Any Folder to Speed Read
		this.addCommand({
			id: "velocity-speed-read-choose-note",
			name: "Choose Note from Any Folder to Speed Read",
			callback: () => {
				this.promptChooseNoteAndRead();
			},
		});

		// 4. Register Context Menu Item on Right-Click
		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu, editor, view) => {
				if (!(view instanceof MarkdownView)) return;
				const hasSelection = editor.somethingSelected();
				menu.addItem((item) => {
					item.setTitle(
						hasSelection
							? "Speed Read Selected Text"
							: "Speed Read Active Note"
					)
						.setIcon("gauge")
						.onClick(() => {
							this.launchReaderFromEditor(editor, view);
						});
				});
			})
		);

		// 5. Settings Tab
		this.addSettingTab(new VelocityReaderSettingTab(this.app, this));
	}

	onunload(): void {
		// Clean up
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/**
	 * Handles clicking the ribbon icon on the left bar.
	 * - If an active editor has selected text -> reads selected text.
	 * - If an active note is open and has readable text -> reads it.
	 * - If active note is empty or no note is open -> automatically opens NoteSuggestModal.
	 */
	async handleRibbonClick(): Promise<void> {
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		const activeFile = this.app.workspace.getActiveFile();

		// 1. If an active editor has selected text, read selection immediately
		if (activeView?.editor?.somethingSelected()) {
			this.launchReaderFromEditor(activeView.editor, activeView);
			return;
		}

		// 2. If an active file is open, check if it has content
		if (activeFile) {
			try {
				let content = "";
				if (activeView?.editor) {
					content = activeView.editor.getValue();
				}
				if (!content || content.trim().length === 0) {
					content = await this.app.vault.cachedRead(activeFile);
				}
				if (content && content.trim().length > 0) {
					const processed = processText(content);
					if (processed.words.length > 0) {
						new SpeedReaderModal(this.app, this, processed, activeFile.basename).open();
						return;
					}
				}
			} catch (e) {
				console.error("Velocity Reader: Error reading active file", e);
			}
		}

		// 3. Otherwise (no note open, or active note is empty), open note picker immediately
		this.promptChooseNoteAndRead();
	}

	/**
	 * Opens a search modal allowing the user to pick any note from any vault folder.
	 */
	promptChooseNoteAndRead(callback?: (file: TFile, doc: ProcessedDocument) => void): void {
		const allMarkdownFiles = this.app.vault.getMarkdownFiles();
		if (!allMarkdownFiles || allMarkdownFiles.length === 0) {
			new Notice("Velocity Reader: Vo vašom trezore sa nenašli žiadne poznámky.");
			return;
		}

		new NoteSuggestModal(this.app, async (file: TFile) => {
			try {
				let content = await this.app.vault.cachedRead(file);
				if (!content || content.trim().length === 0) {
					content = await this.app.vault.read(file);
				}
				const processed = processText(content || "");
				if (processed.words.length === 0) {
					new Notice(`Velocity Reader: Poznámka "${file.basename}" neobsahuje žiadny čitateľný text.`);
					return;
				}

				if (callback) {
					callback(file, processed);
				} else {
					new SpeedReaderModal(this.app, this, processed, file.basename).open();
				}
			} catch (err) {
				console.error("Velocity Reader: Chyba pri čítaní súboru", err);
				new Notice(`Velocity Reader: Nepodarilo sa načítať súbor "${file.basename}".`);
			}
		}).open();
	}

	/**
	 * Extracts text from editor (selection, cursor to end, or entire note if cursor is at end)
	 * and launches the SpeedReaderModal.
	 */
	launchReaderFromEditor(editor: Editor, view: MarkdownView): void {
		let textToRead = "";
		let title = view.file ? view.file.basename : "Dokument";

		if (editor.somethingSelected()) {
			textToRead = editor.getSelection();
			title = `${title} (Výber)`;
		} else {
			const cursor = editor.getCursor();
			const lastLine = editor.lineCount() - 1;
			const lastLineLength = editor.getLine(lastLine).length;
			const fromCursor = editor.getRange(cursor, {
				line: lastLine,
				ch: lastLineLength,
			});

			if (fromCursor && fromCursor.trim().length > 0) {
				textToRead = fromCursor;
			} else {
				// Cursor was at the end of the note -> read entire document from start!
				textToRead = editor.getValue();
			}
		}

		if (!textToRead || textToRead.trim().length === 0) {
			new Notice("Velocity Reader: Aktuálna poznámka je prázdna. Otváram výber inej poznámky...");
			this.promptChooseNoteAndRead();
			return;
		}

		const processed = processText(textToRead);
		if (processed.words.length === 0) {
			new Notice("Velocity Reader: V poznámke sa nenašiel čitateľný text. Otváram výber inej poznámky...");
			this.promptChooseNoteAndRead();
			return;
		}

		new SpeedReaderModal(this.app, this, processed, title).open();
	}
}

class VelocityReaderSettingTab extends PluginSettingTab {
	plugin: VelocityReaderPlugin;

	constructor(app: App, plugin: VelocityReaderPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Velocity Reader Settings" });

		// Default Reading Speed (WPM)
		new Setting(containerEl)
			.setName("Default Reading Speed (WPM)")
			.setDesc("Starting reading speed in Words Per Minute (50 to 3000 WPM).")
			.addSlider((slider) =>
				slider
					.setLimits(50, 3000, 25)
					.setValue(this.plugin.settings.defaultWpm)
					.setDynamicTooltip()
					.onChange(async (val) => {
						this.plugin.settings.defaultWpm = val;
						await this.plugin.saveSettings();
					})
			);

		// Default Mode
		new Setting(containerEl)
			.setName("Default Reading Mode")
			.setDesc("Select which mode opens by default.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("rsvp", "RSVP / Prime Reader (Single Word)")
					.addOption("context", "Contextual Flow (Multi-Paragraph)")
					.setValue(this.plugin.settings.defaultMode)
					.onChange(async (val) => {
						this.plugin.settings.defaultMode = val as ReadingMode;
						await this.plugin.saveSettings();
					})
			);

		// Smart Micro-Pauses
		new Setting(containerEl)
			.setName("Smart Micro-Pauses")
			.setDesc(
				"Subtly extends duration at punctuation (,;: 1.3x; .!? 1.6x) and long words (>10 chars: 1.2x)."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.smartMicroPauses)
					.onChange(async (val) => {
						this.plugin.settings.smartMicroPauses = val;
						await this.plugin.saveSettings();
					})
			);

		// ORP Accent Color
		new Setting(containerEl)
			.setName("ORP Focal Letter Accent Color")
			.setDesc("Color used to highlight the focal letter in RSVP mode.")
			.addText((text) =>
				text
					.setPlaceholder("#e06c75")
					.setValue(this.plugin.settings.orpAccentColor)
					.onChange(async (val) => {
						this.plugin.settings.orpAccentColor = val.trim() || "#e06c75";
						await this.plugin.saveSettings();
					})
			);

		// RSVP Font Size
		new Setting(containerEl)
			.setName("RSVP Font Size (px)")
			.setDesc("Font size for the single-word RSVP viewer (24px to 80px).")
			.addSlider((slider) =>
				slider
					.setLimits(24, 80, 2)
					.setValue(this.plugin.settings.rsvpFontSize)
					.setDynamicTooltip()
					.onChange(async (val) => {
						this.plugin.settings.rsvpFontSize = val;
						await this.plugin.saveSettings();
					})
			);

		// Contextual Flow Font Size
		new Setting(containerEl)
			.setName("Contextual Flow Font Size (px)")
			.setDesc("Font size for the multi-paragraph flow viewer (14px to 36px).")
			.addSlider((slider) =>
				slider
					.setLimits(14, 36, 1)
					.setValue(this.plugin.settings.contextFontSize)
					.setDynamicTooltip()
					.onChange(async (val) => {
						this.plugin.settings.contextFontSize = val;
						await this.plugin.saveSettings();
					})
			);

		// Context Mode Paragraph Count
		new Setting(containerEl)
			.setName("Context Mode Paragraphs per Page")
			.setDesc("How many paragraphs to display per viewport chunk in Context Flow mode (1 to 3).")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("1", "1 Paragraph")
					.addOption("2", "2 Paragraphs")
					.addOption("3", "3 Paragraphs")
					.setValue(this.plugin.settings.paragraphsPerPage.toString())
					.onChange(async (val) => {
						this.plugin.settings.paragraphsPerPage = parseInt(val, 10);
						await this.plugin.saveSettings();
					})
			);
	}
}
