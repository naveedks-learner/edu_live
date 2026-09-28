export type GuardrailReason = "age_inappropriate" | "out_of_scope" | "guardrail_error" | null;

export interface GuardrailDecision {
  allowed: boolean;
  reason: GuardrailReason;
  refusalMessage: string | null;
}

// Specific phrases only - bare words like "drugs" or "sex" also appear in
// legitimate biology/chemistry curriculum content (drug interactions,
// sexual reproduction in plants, etc.) and would false-positive block them.
// "get high" was narrowed to "get high on" after live review found it
// matching "get high enough to reach orbit" (physics) and "get higher
// marks" (a student asking about grades).
const BLOCKED_PHRASES = [
  "hurt myself", "kill myself", "self harm", "self-harm", "suicide",
  "cut myself", "want to die",
  "buy drugs", "illegal drugs", "get high on", "cocaine", "heroin", "drug dealer",
  "porn", "nude photos", "naked pics", "send nudes",
  "kill someone", "how to make a bomb", "how to make a weapon",
];

export const IN_SCOPE_EXAMPLE_QUESTIONS = [
  "What is Newton's second law of motion?",
  "How do you factorise a quadratic equation?",
  "Explain the process of photosynthesis.",
  "What is the difference between speed and velocity?",
  "How do you find the derivative of a function?",
  "What are the states of matter?",
  "Explain Ohm's law with an example.",
  "How do you solve a system of linear equations?",
  "What is the periodic table and how is it organized?",
  "What is the Pythagorean theorem?",
];

export const OUT_OF_SCOPE_EXAMPLE_QUESTIONS = [
  "Who won the football match yesterday?",
  "What's the best movie to watch this weekend?",
  "Can you help me write a message to ask someone out?",
  "What's your favorite celebrity gossip?",
  "How do I get more followers on social media?",
  "Tell me a joke about my teacher.",
  "What should I cook for dinner tonight?",
  "Give me relationship advice.",
];

export const REFUSAL_AGE_INAPPROPRIATE =
  "I can't help with that here. If you're going through something difficult, " +
  "please talk to a teacher, parent, or trusted adult. I'm happy to help with " +
  "science and maths questions any time!";

export const REFUSAL_OUT_OF_SCOPE =
  "I can only help with science and maths topics here. Try asking me something " +
  "from your science or maths syllabus!";

export const REFUSAL_GUARDRAIL_ERROR =
  "I'm temporarily unable to check that question - please try again in a moment.";

export const DEFAULT_MIN_IN_SCOPE_SIMILARITY = 0.35;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Word-boundary matching (not plain substring) so a blocked phrase must
// appear as whole words - "heroin" no longer matches inside "heroine".
const BLOCKED_PHRASE_PATTERNS = BLOCKED_PHRASES.map(
  (phrase) => new RegExp(`\\b${escapeRegExp(phrase)}\\b`, "i")
);

export function containsBlockedKeyword(question: string): boolean {
  return BLOCKED_PHRASE_PATTERNS.some((pattern) => pattern.test(question));
}

export function decideGuardrailOutcome(
  keywordBlocked: boolean,
  inScopeSimilarity: number,
  outScopeSimilarity: number,
  minInScopeSimilarity: number = DEFAULT_MIN_IN_SCOPE_SIMILARITY
): GuardrailDecision {
  if (keywordBlocked) {
    return { allowed: false, reason: "age_inappropriate", refusalMessage: REFUSAL_AGE_INAPPROPRIATE };
  }

  if (inScopeSimilarity < minInScopeSimilarity || inScopeSimilarity <= outScopeSimilarity) {
    return { allowed: false, reason: "out_of_scope", refusalMessage: REFUSAL_OUT_OF_SCOPE };
  }

  return { allowed: true, reason: null, refusalMessage: null };
}
