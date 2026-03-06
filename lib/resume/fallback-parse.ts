import { parsedResumeSchema, type ParsedResume } from "@/lib/ai/schemas";

const EMAIL_REGEX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE_REGEX =
  /(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?)?\d{3,4}[\s.-]?\d{3,4}/;
const URL_REGEX = /https?:\/\/[^\s)]+/gi;

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "you",
  "your",
  "have",
  "has",
  "are",
  "was",
  "were",
  "will",
  "can",
  "not",
  "but",
  "all",
  "any",
  "our",
  "out",
  "about",
  "into",
  "using",
  "used",
  "work",
  "years",
  "year",
  "experience",
  "skills",
  "education",
  "project",
  "projects",
  "summary",
  "resume",
  "profile",
  "candidate",
  "interview",
  "role",
]);

function normalizeLine(line: string): string {
  return line.replace(/\u0000/g, " ").replace(/\s+/g, " ").trim();
}

function extractTopName(lines: string[]): string | undefined {
  for (const line of lines.slice(0, 12)) {
    if (
      line.length < 2 ||
      line.length > 60 ||
      EMAIL_REGEX.test(line) ||
      PHONE_REGEX.test(line) ||
      /https?:\/\//i.test(line) ||
      /\d/.test(line)
    ) {
      continue;
    }

    if (!/^[A-Za-z][A-Za-z\s.'-]+$/.test(line)) {
      continue;
    }

    return line;
  }

  return undefined;
}

function extractLinks(text: string) {
  const found = text.match(URL_REGEX) ?? [];
  const seen = new Set<string>();
  const links: { label: string; url: string }[] = [];

  for (const candidate of found) {
    const sanitized = candidate.replace(/[.,;:!?]+$/, "");
    if (!/^https?:\/\/\S+$/i.test(sanitized) || seen.has(sanitized)) {
      continue;
    }

    seen.add(sanitized);
    links.push({
      label: links.length === 0 ? "Portfolio" : `Link ${links.length + 1}`,
      url: sanitized,
    });

    if (links.length >= 20) {
      break;
    }
  }

  return links;
}

function extractSkills(lines: string[]) {
  const skillSet = new Set<string>();

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!/^skills?\b/i.test(line)) {
      continue;
    }

    const values = line.replace(/^skills?\s*:?\s*/i, "");
    const candidatePool = [values, lines[i + 1] ?? "", lines[i + 2] ?? ""];

    for (const candidate of candidatePool) {
      for (const token of candidate.split(/[,\|•]/g)) {
        const normalized = token
          .replace(/^[\s.-]+|[\s.-]+$/g, "")
          .replace(/\s+/g, " ")
          .trim();

        if (!normalized || normalized.length < 2 || normalized.length > 80) {
          continue;
        }

        skillSet.add(normalized);
        if (skillSet.size >= 200) {
          return Array.from(skillSet);
        }
      }
    }
  }

  return Array.from(skillSet);
}

function extractSummary(lines: string[]): string | undefined {
  const heading = /^(summary|profile|about)\b/i;
  const blocked = /^(skills?|experience|education|projects?|certifications?)\b/i;

  for (let i = 0; i < lines.length; i += 1) {
    if (!heading.test(lines[i])) {
      continue;
    }

    const chunks: string[] = [];
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j += 1) {
      if (blocked.test(lines[j])) {
        break;
      }
      chunks.push(lines[j]);
    }

    const summary = chunks.join(" ").trim();
    if (summary) {
      return summary.slice(0, 600);
    }
  }

  const fallback = lines
    .slice(0, 6)
    .filter((line) => !EMAIL_REGEX.test(line) && !PHONE_REGEX.test(line))
    .join(" ")
    .trim();

  return fallback ? fallback.slice(0, 600) : undefined;
}

function extractKeywords(text: string) {
  const counts = new Map<string, number>();
  const tokens = text.match(/[A-Za-z][A-Za-z0-9+#.-]{2,30}/g) ?? [];

  for (const raw of tokens) {
    const token = raw.toLowerCase();
    if (STOPWORDS.has(token)) {
      continue;
    }
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 200)
    .map(([token]) => token);
}

export function fallbackParseResume(text: string): ParsedResume {
  const lines = text
    .split(/\r?\n/g)
    .map(normalizeLine)
    .filter(Boolean);

  const email = text.match(EMAIL_REGEX)?.[0]?.toLowerCase();
  const phone = text.match(PHONE_REGEX)?.[0];
  const name = extractTopName(lines);
  const links = extractLinks(text);
  const skills = extractSkills(lines).map((name) => ({ name }));
  const summary = extractSummary(lines);
  const keywords = extractKeywords(text);

  return parsedResumeSchema.parse({
    basics: {
      name,
      email,
      phone,
      location: undefined,
      links,
    },
    summary,
    skills,
    workExperience: [],
    education: [],
    projects: [],
    certifications: [],
    achievements: [],
    keywords,
  });
}
