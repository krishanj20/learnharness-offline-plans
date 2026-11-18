import { createHash } from "node:crypto";
import { Type } from "typebox";

const text = Type.String({ minLength: 1, maxLength: 8_000 });
const isLocalProse = value => typeof value === "string" && value.trim().length > 0
  && !/!\[|<\s*(?:img|video|audio|iframe|source|picture|embed|object)\b/i.test(value);
const option = Type.Object({
  label: Type.String({ minLength: 1, maxLength: 500 }),
  value: Type.String({ pattern: "^[a-z0-9_-]{1,40}$" }),
  feedback: text,
}, { additionalProperties: false });
const questionFields = {
  question: text,
  options: Type.Array(option, { minItems: 2, maxItems: 5 }),
  correctAnswer: Type.String({ pattern: "^[a-z0-9_-]{1,40}$" }),
};
export const lessonSchema = Type.Object({
  explanation: text,
  example: text,
  checks: Type.Array(Type.Object({
    ...questionFields,
    alternateExample: text,
    followUp: Type.Object(questionFields, { additionalProperties: false }),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 5 }),
}, { additionalProperties: false });

export const outlineSchema = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 160 }),
  lessons: Type.Array(Type.Object({
    title: Type.String({ minLength: 1, maxLength: 160 }),
    nodeIds: Type.Array(Type.String(), { minItems: 1 }),
  }, { additionalProperties: false }), { minItems: 1 }),
}, { additionalProperties: false });

// Convert the tutor's concepts into lessons without dropping a concept or
// scheduling it before an external prerequisite.
export function statedLessonCount(presentation) {
  // Older hosts store lesson boundaries in prose. Guard an unambiguous
  // explicit count; the outline worker interprets other phrasings/languages.
  const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
  const counts = new Set();
  const pattern = /\b(single|one|two|three|four|five|six|seven|eight|nine|ten|[1-9]\d*)[\s-]+(?:(?:short|brief|substantial|offline|focused|compact|integrated)\s+)*lessons?\b/gi;
  for (const match of presentation.matchAll(pattern)) {
    const before = presentation.slice(0, match.index);
    const after = presentation.slice(match.index + match[0].length);
    const specifiesTotal = /\b(?:plan (?:of|for)|course (?:of|in)|exactly|consists of|use|into)\s+(?:a\s+)?$/i.test(before)
      || /^[- ](?:plan|course)\b/i.test(after);
    if (!specifiesTotal) continue;
    const word = match[1].toLowerCase();
    counts.add(word === "single" ? 1 : words.includes(word) ? words.indexOf(word) : Number(word));
  }
  return counts.size === 1 ? [...counts][0] : undefined;
}

export function groupLessons(nodes, outline, expectedCount) {
  if (expectedCount && outline.lessons.length !== expectedCount) {
    throw new Error(`The teaching plan specifies ${expectedCount} lesson(s). Keep that lesson count.`);
  }
  const byId = new Map(nodes.map(node => [node.id, node]));
  const assigned = new Map();
  const lessons = outline.lessons.map(({ title, nodeIds }, index) => {
    const id = `lesson-${index + 1}`;
    const group = new Set(nodeIds);
    for (const nodeId of nodeIds) {
      if (!byId.has(nodeId) || assigned.has(nodeId)) throw new Error("Each plan concept must occur exactly once.");
      assigned.set(nodeId, id);
    }
    const concepts = nodes.filter(node => group.has(node.id));
    const prerequisites = new Set();
    for (const concept of concepts) {
      for (const required of concept.prerequisites) {
        const earlier = assigned.get(required);
        if (!earlier) throw new Error("A lesson precedes its prerequisite.");
        if (earlier !== id) prerequisites.add(earlier);
      }
    }
    return { id, title, concepts, prerequisites: [...prerequisites] };
  });
  if (assigned.size !== nodes.length) throw new Error("The lesson outline omits a plan concept.");
  return lessons;
}

export function validateLesson(lesson) {
  if (![lesson.explanation, lesson.example].every(isLocalProse)) {
    throw new Error("Provide a substantive explanation and worked example.");
  }
  for (const check of lesson.checks) {
    if (!isLocalProse(check.alternateExample)) throw new Error("Each check needs a second worked example.");
    for (const question of [check, check.followUp]) {
      const problems = [];
      const keys = question.options.map(option => option.value);
      if (new Set(keys).size !== keys.length) problems.push("Use a unique value for each choice.");
      if (!keys.includes(question.correctAnswer)) problems.push("The answer key does not match any option value.");
      if (!isLocalProse(question.question) || question.options.some(option => !isLocalProse(option.feedback))) {
        problems.push("Provide a question and specific feedback for every option.");
      }
      const labels = question.options.map(option => option.label.trim().toLowerCase());
      if (labels.includes("") || new Set(labels).size !== labels.length) problems.push("Give each answer choice a distinct label.");
      if (problems.length) throw new Error(problems.join(" "));
    }
    if (check.question.trim().toLowerCase() === check.followUp.question.trim().toLowerCase()) {
      throw new Error("The follow-up must ask a fresh question.");
    }
  }
}

export function capturePlan(sessionId, tree, presentation = "") {
  const nodes = new Map(tree.nodes.map(node => [node.id, { ...node, prerequisites: [] }]));
  if (!nodes.size || nodes.size !== tree.nodes.length) throw new Error("This teaching plan has invalid topics.");
  for (const { from, to } of tree.edges) {
    if (!nodes.has(from) || !nodes.has(to)) throw new Error("This teaching plan has an invalid prerequisite.");
    nodes.get(to).prerequisites.push(from);
  }
  for (const node of nodes.values()) node.prerequisites.sort();
  const ordered = [];
  const seen = new Set();
  while (ordered.length < nodes.size) {
    const next = [...nodes.values()].find(node =>
      !seen.has(node.id) && node.prerequisites.every(id => seen.has(id)));
    if (!next) throw new Error("This teaching plan has circular prerequisites.");
    seen.add(next.id);
    ordered.push(next);
  }
  const id = createHash("sha256").update(JSON.stringify(["lesson-groups", sessionId, ordered, presentation])).digest("hex");
  return { id, topics: ordered };
}

function questionView(question, value) {
  const { options, correctAnswer } = question;
  const selected = options.find(option => option.value === value);
  return {
    question: question.question,
    options: options.map(({ value, label }) => ({ value, label })),
    answer: selected && {
      value,
      correct: selected.value === correctAnswer,
      feedback: selected.feedback,
      solution: options.find(option => option.value === correctAnswer).label,
    },
  };
}

const attemptKey = (lesson, check, followUp) => [lesson, check, followUp ? "follow-up" : "main"].join(":");

export function studyLesson(course, lessonIndex) {
  const lesson = course.lessons[lessonIndex];
  if (course.lessons.length !== course.topics.length || !lesson || lessonIndex > course.completed) {
    throw new Error("This lesson is unavailable.");
  }
  return {
    ...course.topics[lessonIndex],
    explanation: lesson.explanation,
    example: lesson.example,
    checks: lesson.checks.map((check, index) => {
      const question = questionView(check, course.answers[attemptKey(lessonIndex, index, false)]);
      if (question.answer?.correct === false) {
        question.alternateExample = check.alternateExample;
        question.followUp = questionView(check.followUp, course.answers[attemptKey(lessonIndex, index, true)]);
      }
      return question;
    }),
  };
}

export function recordAnswer(course, { lesson, check, followUp, value }) {
  const view = studyLesson(course, lesson);
  const base = view.checks[check];
  const question = followUp ? base?.followUp : base;
  if (!question?.options.some(option => option.value === value)) throw new Error("Choose an available answer.");
  const key = attemptKey(lesson, check, followUp);
  if (course.answers[key] === value) return;
  if (course.answers[key] !== undefined || lesson !== course.completed) throw new Error("This answer is already settled.");
  course.answers[key] = value;
}

export function completeLesson(course, index) {
  if (index < course.completed) return;
  const lesson = studyLesson(course, index);
  if (lesson.checks.some(check => !check.answer)) throw new Error("Answer each check before continuing.");
  course.completed++;
}
