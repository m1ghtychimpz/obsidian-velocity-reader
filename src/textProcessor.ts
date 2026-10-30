export interface OrpSegments {
	prefix: string;
	orpChar: string;
	suffix: string;
	orpIndex: number;
}

export interface SaccadicSegments {
	leadChars: string;
	coreChars: string;
	trailChars: string;
}

export interface ParsedWord {
	/** Global index across the entire loaded document/selection */
	index: number;
	/** Index of the paragraph this word belongs to */
	paragraphIndex: number;
	/** Index of the word within its parent paragraph */
	wordIndexInParagraph: number;
	/** Cleaned display text of the word */
	text: string;
	/** Character length (Unicode code points) excluding surrounding punctuation */
	cleanLength: number;
	/** Pre-calculated Optimal Recognition Point segments for RSVP (Prime) mode */
	orp: OrpSegments;
	/** Pre-calculated Saccadic Letter Bridging segments for Contextual Flow mode */
	saccadic: SaccadicSegments;
	/** Smart Micro-Pause multiplier when micro-pauses are enabled */
	pauseMultiplier: number;
	/** Whether this word concludes a sentence (ends with ., !, or ?) */
	isSentenceEnd: boolean;
}

export interface ParsedParagraph {
	index: number;
	words: ParsedWord[];
	startWordIndex: number;
	endWordIndex: number;
}

export interface ProcessedDocument {
	paragraphs: ParsedParagraph[];
	words: ParsedWord[];
}

/**
 * Strips raw Markdown syntax while preserving readable text and paragraph breaks (\n\n).
 * Handles:
 * - YAML frontmatter (if at start of text)
 * - [[wikilinks|aliases]] and [[wikilinks]] -> keeps display text
 * - ![[embeds]] and ![alt](url)
 * - [markdown links](url) -> keeps display text
 * - Raw URLs (http://, https://)
 * - Code blocks / inline code backticks (`)
 * - Bold/italic/strikethrough/highlight markers (**, *, __, _, ~~, ==)
 * - Heading markers (#) and blockquote markers (>)
 * - HTML tags
 */
export function stripMarkdownFormatting(rawMarkdown: string): string {
	if (!rawMarkdown) {
		return "";
	}

	let text = rawMarkdown.replace(/\r\n/g, "\n");

	// 1. Strip YAML frontmatter if present at the very beginning
	text = text.replace(/^---\n[\s\S]*?\n---\n?/, "");

	// 2. Remove fenced code block delimiters (keep inner text readable)
	text = text.replace(/```[\w-]*\n?/g, "");
	text = text.replace(/~~~[\w-]*\n?/g, "");

	// 3. Clean Obsidian embeds: ![[file|alias]] -> alias, ![[file]] -> remove
	text = text.replace(/!\[\[([^|\]]+)\|([^\]]+)\]\]/g, "$2");
	text = text.replace(/!\[\[([^\]]+)\]\]/g, "");

	// 4. Clean Obsidian wikilinks: [[target|alias]] -> alias, [[target#heading]] -> target heading, [[target]] -> target
	text = text.replace(/\[\[(?:[^|\]]*\|)?([^\]]+)\]\]/g, (_match, display: string) => {
		return display.replace(/#/g, " ").trim();
	});

	// 5. Clean Markdown images ![alt](url) -> alt, and standard links [text](url) -> text
	text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1");
	text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

	// 6. Remove raw URLs (http://, https://, www.)
	text = text.replace(/https?:\/\/[^\s)\]>]+/gi, "");
	text = text.replace(/\bwww\.[^\s)\]>]+/gi, "");

	// 7. Strip HTML tags
	text = text.replace(/<\/?[a-z][^>]*>/gi, "");

	// 8. Strip line-level Markdown prefixes (headings #, blockquotes >, list checkboxes, horizontal rules)
	text = text.replace(/^[ \t]*#{1,6}[ \t]+/gm, "");
	text = text.replace(/^[ \t]*>[ \t>]*?/gm, "");
	text = text.replace(/^[ \t]*[-*+][ \t]+\[[ xX]\][ \t]+/gm, "");
	text = text.replace(/^[ \t]*[-*+][ \t]+/gm, "");
	text = text.replace(/^[ \t]*(?:---|\*\*\*|___)[ \t]*$/gm, "");

	// 9. Remove inline formatting tokens: **, *, __, ~~, ==, inline backticks `, and stray # or >
	text = text.replace(/(\*\*|\*|__|~~|==|`)/g, "");
	text = text.replace(/[#>`]/g, "");

	// 10. Clean remaining single underscores used for emphasis around words (preserve snake_case if needed, or strip outer _)
	text = text.replace(/(^|\s)_+([^_\s]+)_+(?=\s|$|[.,!?;:])/g, "$1$2");

	// 11. Collapse multiple spaces/tabs on the same line, while preserving paragraph breaks (\n\n)
	text = text
		.replace(/[ \t]+/g, " ")
		.replace(/\n[ \t]+/g, "\n")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{2,}/g, "\n\n")
		.trim();

	return text;
}

/**
 * Calculates the Optimal Recognition Point (ORP) focal character index:
 * - 1 char: index 0
 * - 2–5 chars: index 1
 * - 6–9 chars: index 2
 * - 10–13 chars: index 3
 * - 14+ chars: index 4
 */
export function calculateOrpIndex(word: string): number {
	const chars = Array.from(word);
	const len = chars.length;
	if (len <= 1) return 0;
	if (len <= 5) return 1;
	if (len <= 9) return 2;
	if (len <= 13) return 3;
	return 4;
}

/**
 * Splits a word into three parts (`prefix`, `orpChar`, `suffix`) around the ORP focal index.
 */
export function splitWordForOrp(word: string): OrpSegments {
	const chars = Array.from(word);
	if (chars.length === 0) {
		return { prefix: "", orpChar: "", suffix: "", orpIndex: 0 };
	}
	const orpIndex = Math.min(calculateOrpIndex(word), chars.length - 1);
	return {
		prefix: chars.slice(0, orpIndex).join(""),
		orpChar: chars[orpIndex] ?? "",
		suffix: chars.slice(orpIndex + 1).join(""),
		orpIndex,
	};
}

/**
 * Pre-parses a word into three non-overlapping sub-spans for Saccadic Edge Highlighting:
 * - `leadChars`: first 2 letters (or 1 for very short words)
 * - `coreChars`: middle letters
 * - `trailChars`: last 2 letters (or 1 for 2-3 letter words, empty for 1-letter words)
 */
export function splitWordForSaccadic(word: string): SaccadicSegments {
	const chars = Array.from(word);
	const len = chars.length;

	if (len === 0) {
		return { leadChars: "", coreChars: "", trailChars: "" };
	}
	if (len === 1) {
		return { leadChars: chars[0], coreChars: "", trailChars: "" };
	}
	if (len === 2) {
		return { leadChars: chars[0], coreChars: "", trailChars: chars[1] };
	}
	if (len === 3) {
		return {
			leadChars: chars.slice(0, 2).join(""),
			coreChars: "",
			trailChars: chars[2],
		};
	}

	// len >= 4: first 2 chars = leadChars, middle = coreChars, last 2 chars = trailChars
	return {
		leadChars: chars.slice(0, 2).join(""),
		coreChars: chars.slice(2, len - 2).join(""),
		trailChars: chars.slice(len - 2).join(""),
	};
}

/**
 * Calculates the smart micro-pause duration multiplier for a word:
 * - Words ending with `,`, `;`, `:` -> 1.3x duration
 * - Words ending with `.`, `!`, `?` -> 1.6x duration
 * - Words longer than 10 characters -> 1.2x duration
 */
export function calculatePauseMetadata(word: string): {
	pauseMultiplier: number;
	isSentenceEnd: boolean;
	cleanLength: number;
} {
	// Strip trailing quotes/brackets so e.g. `hello."` still detects the period
	const trimmedTrailingQuotes = word.replace(/['"”’)\]}]+$/, "");
	const lastChar = trimmedTrailingQuotes.slice(-1);

	const cleanWord = word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
	const cleanLength = Array.from(cleanWord || word).length;

	let pauseMultiplier = 1.0;
	let isSentenceEnd = false;

	if (lastChar === "." || lastChar === "!" || lastChar === "?") {
		pauseMultiplier *= 1.6;
		isSentenceEnd = true;
	} else if (lastChar === "," || lastChar === ";" || lastChar === ":") {
		pauseMultiplier *= 1.3;
	}

	if (cleanLength > 10) {
		pauseMultiplier *= 1.2;
	}

	return {
		pauseMultiplier,
		isSentenceEnd,
		cleanLength,
	};
}

/**
 * Tokenizes raw Markdown into structured paragraphs and pre-segmented words
 * ready for zero-allocation RSVP and Contextual Flow rendering.
 */
export function processText(rawMarkdown: string): ProcessedDocument {
	const cleaned = stripMarkdownFormatting(rawMarkdown);
	if (!cleaned) {
		return { paragraphs: [], words: [] };
	}

	const rawParagraphs = cleaned
		.split(/\n{2,}/)
		.map((p) => p.replace(/\n+/g, " ").trim())
		.filter((p) => p.length > 0);

	const paragraphs: ParsedParagraph[] = [];
	const allWords: ParsedWord[] = [];

	let globalWordIndex = 0;

	for (let pIdx = 0; pIdx < rawParagraphs.length; pIdx++) {
		const rawTokens = rawParagraphs[pIdx]
			.split(/\s+/)
			.map((t) => t.trim())
			.filter((t) => t.length > 0);

		if (rawTokens.length === 0) {
			continue;
		}

		const paragraphIndex = paragraphs.length;
		const paragraphWords: ParsedWord[] = [];
		const startWordIndex = globalWordIndex;

		for (let wIdx = 0; wIdx < rawTokens.length; wIdx++) {
			const token = rawTokens[wIdx];
			const orp = splitWordForOrp(token);
			const saccadic = splitWordForSaccadic(token);
			const { pauseMultiplier, isSentenceEnd, cleanLength } = calculatePauseMetadata(token);

			const parsedWord: ParsedWord = {
				index: globalWordIndex,
				paragraphIndex,
				wordIndexInParagraph: wIdx,
				text: token,
				cleanLength,
				orp,
				saccadic,
				pauseMultiplier,
				isSentenceEnd,
			};

			paragraphWords.push(parsedWord);
			allWords.push(parsedWord);
			globalWordIndex++;
		}

		paragraphs.push({
			index: paragraphIndex,
			words: paragraphWords,
			startWordIndex,
			endWordIndex: globalWordIndex - 1,
		});
	}

	return {
		paragraphs,
		words: allWords,
	};
}
