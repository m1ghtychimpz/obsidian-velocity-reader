import {
	App,
	Editor,
	MarkdownView,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
} from "obsidian";
import { SpeedReaderModal, ReadingMode } from "./speedReaderModal";
import { processText } from "./textProcessor";

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

export default class VelocityReaderPlugin extends Plugin {
	settings: VelocityReaderSettings = DEFAULT_SETTINGS;

	async onload(): Promise<void> {
		await this.loadSettings();

		// 1. Register Editor Command
		this.addCommand({
			id: "velocity-speed-read-selected",
			name: "Speed Read Selected Text",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				this.launchReaderFromEditor(editor, view);
			},
		});

		// 2. Register Context Menu Item on Right-Click
		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu, editor, view) => {
				if (!(view instanceof MarkdownView)) return;
				const hasSelection = editor.somethingSelected();
				menu.addItem((item) => {
					item.setTitle(
						hasSelection
							? "Speed Read Selected Text"
							: "Speed Read from Cursor to End"
					)
						.setIcon("gauge")
						.onClick(() => {
							this.launchReaderFromEditor(editor, view);
						});
				});
			})
		);

		// 3. Settings Tab
		this.addSettingTab(new VelocityReaderSettingTab(this.app, this));
	}

	onunload(): void {
		// Clean up on unload if needed
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/**
	 * Extracts text from editor (selection or cursor to end of document)
	 * and launches the SpeedReaderModal.
	 */
	launchReaderFromEditor(editor: Editor, _view: MarkdownView): void {
		let textToRead = "";

		if (editor.somethingSelected()) {
			textToRead = editor.getSelection();
		} else {
			const cursor = editor.getCursor();
			const lastLine = editor.lineCount() - 1;
			const lastLineLength = editor.getLine(lastLine).length;
			textToRead = editor.getRange(cursor, {
				line: lastLine,
				ch: lastLineLength,
			});
		}

		const processed = processText(textToRead);
		if (processed.words.length === 0) {
			new Notice("Velocity Reader: No readable text found to read.");
			return;
		}

		new SpeedReaderModal(this.app, this, processed).open();
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
