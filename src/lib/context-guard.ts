// Context Guard — client-side off-topic detection for session messages.
// Compares a new message against session title + first prompt using keyword overlap.

const STOPWORDS = new Set([
  "a","an","the","is","are","was","were","be","been","being","have","has","had",
  "do","does","did","will","would","shall","should","may","might","must","can",
  "could","am","i","me","my","we","our","you","your","he","she","it","its",
  "they","them","their","this","that","these","those","what","which","who",
  "whom","where","when","how","why","all","each","every","both","few","more",
  "most","some","any","no","not","only","own","same","so","than","too","very",
  "just","also","about","above","after","again","against","and","as","at",
  "before","below","between","but","by","down","during","for","from","get",
  "got","if","in","into","of","off","on","or","out","over","per","then","to",
  "up","with","don","doesn","didn","won","wouldn","shouldn","couldn","isn",
  "aren","wasn","weren","let","use","using","used","make","made","like","need",
  "want","try","new","add","file","code","please","help","thanks","think",
]);

const SKIP_PATTERN = /^(continue|proceed|go ahead|keep going|ok|okay|yes|no|y|n|thanks|thank you|done|stop|cancel|retry|got it|sure|right|correct|ack|acknowledged|next|go on|lgtm|looks good|ship it|approved|nope|nah|yep|yeah|fine|good|great|perfect|nice|cool|awesome|agreed|exactly|understood|roger|will do|on it|noted|confirmed|absolutely|definitely|of course|obviously|certainly|please|pls|thx|ty|kk|k|do it|run it|try again|undo|revert|fix it|show me|explain|sounds good)\s*[.!?]?$/i;

const CODE_SIGNALS = /(?:=>|function\s*\(|import\s+|export\s+|const\s+|let\s+|var\s+|class\s+|def\s+|return\s+|\{\s*\n)/;

function tokenize(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\u0400-\u04ff\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  return new Set(words);
}

export interface ContextGuardResult {
  score: number;   // 0-100, off-topic confidence
  skipped: boolean;
  reason?: string;
}

export function checkContextGuard(
  message: string,
  sessionTitle: string | null,
  firstPrompt: string | null,
): ContextGuardResult {
  const trimmed = message.trim();

  // Skip short messages
  if (trimmed.length < 50) {
    return { score: 0, skipped: true, reason: "short message" };
  }

  // Skip command-like messages
  if (SKIP_PATTERN.test(trimmed)) {
    return { score: 0, skipped: true, reason: "command message" };
  }

  // Build context from title + first prompt
  const contextText = [sessionTitle ?? "", (firstPrompt ?? "").slice(0, 500)].join(" ").trim();
  if (contextText.length < 10) {
    return { score: 0, skipped: true, reason: "no context" };
  }

  const contextWords = tokenize(contextText);
  const messageWords = tokenize(trimmed);

  // Too few words for meaningful comparison
  if (contextWords.size < 3 || messageWords.size < 3) {
    return { score: 0, skipped: true, reason: "too few words" };
  }

  // Calculate overlap: what fraction of message words are NOT in context
  let intersection = 0;
  for (const w of messageWords) {
    if (contextWords.has(w)) intersection++;
  }

  let score = Math.round((1 - intersection / messageWords.size) * 100);

  // Dampen score for code-heavy messages (code vocab diverges from titles naturally)
  if (CODE_SIGNALS.test(trimmed)) {
    score = Math.round(score * 0.5);
  }

  return { score, skipped: false };
}
