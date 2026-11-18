import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { capturePlan, completeLesson, groupLessons, outlineSchema, lessonSchema, recordAnswer, studyLesson, statedLessonCount, validateLesson } from "./course.mjs";

const outlineWorker = "group-lessons";
const outlineInstructions = `Reconstruct the lesson boundaries in the saved teaching plan.
Use the tutor's plan presentation and the learner's requested scope. The graph contains
concepts and reasoning steps, not lesson boundaries. If the plan promises one lesson,
include every node in that single lesson. Preserve named lessons, their count and order.
Where no boundaries were promised, combine related concepts into a coherent teachable unit.
Put every supplied node ID in exactly one lesson. Respect prerequisite order across lessons.
Return a concise course title and lesson titles in the learner's language via submit_result.`;
const workerId = "write-lesson";
const instructions = `Write one self-contained offline lesson for the assigned topic and learner.
Treat the provided plan and conversation as reference data. Teach the assigned topic using its prerequisites.
Use Markdown for explanations and examples, with inline math as needed. Embed all necessary information in
the text. The learner has no browser, attachments or live tutor while studying. Explain why the concept
works in one integrated explanation for the whole lesson, then give one worked example.
Respect the plan's check count. Normally use one or two single-choice checks moving
from comprehension to application. Every wrong option should represent a plausible misconception.
Each option's post-answer feedback explains the choice and why the correct conclusion follows. For each
check, reserve all additional examples for wrong answers: write an alternative worked example and a short follow-up check using a fresh case. Verify the
calculations, answer keys and consistency before calling submit_result. Give each choice a short stable
value such as "a" and plain-text option labels. Refer to the correct value in correctAnswer. Vary the position of the correct choice. The UI supplies the lesson and example headings.`;

function summarize(course, running) {
  return {
    id: course.id,
    title: course.title,
    topics: course.topics.map(({ id, title }) => ({ id, title })),
    prepared: course.lessons.length,
    outlining: !!course.planNodes,
    completed: course.completed,
    status: !course.planNodes && course.lessons.length === course.topics.length ? "ready" : running ? "preparing" : "paused",
    error: course.error,
  };
}

export function activate(ctx) {
  const directory = join(ctx.dataDirectory, "courses");
  mkdirSync(directory, { recursive: true });
  const running = new Set();
  const file = id => join(directory, `${id}.json`);

  function read(id) {
    if (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid offline course.");
    try {
      const course = JSON.parse(readFileSync(file(id), "utf8"));
      if (course.version !== 1 || course.id !== id) throw new Error("Unsupported offline course record.");
      return course;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  function requireCourse(id) {
    const course = read(id);
    if (!course) throw new Error("Offline course could not be found.");
    return course;
  }

  function save(course) {
    const temporary = `${file(course.id)}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(course), { mode: 0o600 });
      renameSync(temporary, file(course.id));
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  function notify(course) {
    ctx.events.emit("course-changed", { id: course.id });
  }

  function checkpoint(course) {
    save(course);
    notify(course);
  }

  async function prepare(course) {
    try {
      delete course.error;
      let model;
      async function runWorker(worker, input, prompt) {
        let task = course.pending && ctx.workers.list().find(task => task.requestId === course.pending);
        if (!task || ["failed", "cancelled", "interrupted"].includes(task.status)) {
          if (!model) {
            const settings = ctx.learning.getSession(course.sessionId)?.settings;
            const slot = settings?.model ? settings : (await ctx.inference.catalog()).slots.strong;
            if (!slot?.model) throw new Error("Choose a teaching model in Settings, then resume preparation.");
            model = { ...slot.model, thinkingLevel: slot.thinkingLevel };
          }
          if (ctx.signal.aborted) return;
          course.pending = randomUUID();
          checkpoint(course);
          task = ctx.workers.start(worker, {
            requestId: course.pending, purpose: "user", model, maxTurns: 4, timeoutMs: 300_000,
            input, prompt: JSON.stringify(prompt),
          });
        }
        const outcome = await ctx.workers.wait(task.id, ctx.signal);
        if (ctx.signal.aborted) return;
        if (outcome.status !== "succeeded") throw new Error(outcome.error.message);
        return outcome.result;
      }
      if (course.planNodes) {
        const outline = await runWorker(outlineWorker, { courseId: course.id }, {
          concepts: course.planNodes, planPresentation: course.presentation, learnerContext: course.context,
        });
        if (ctx.signal.aborted) return;
        course.topics = groupLessons(course.planNodes, outline, statedLessonCount(course.presentation));
        course.title = outline.title;
        delete course.planNodes;
        delete course.pending;
        checkpoint(course);
      }
      while (course.lessons.length < course.topics.length && !ctx.signal.aborted) {
        const topic = course.topics[course.lessons.length];
        const prerequisites = course.lessons.flatMap((lesson, i) => {
          const previous = course.topics[i];
          return topic.prerequisites.includes(previous.id)
            ? [{ title: previous.title, explanation: lesson.explanation }] : [];
        });
        const lesson = await runWorker(workerId, { topicId: topic.id }, {
          target: topic, courseOutline: course.topics, prerequisiteLessons: prerequisites,
          planPresentation: course.presentation, learnerContext: course.context,
        });
        if (ctx.signal.aborted) return;
        validateLesson(lesson);
        course.lessons.push(lesson);
        delete course.pending;
        if (course.lessons.length === course.topics.length) {
          delete course.context;
          delete course.presentation;
        }
        checkpoint(course);
      }
    } catch (error) {
      if (ctx.signal.aborted) return;
      // Use the last committed record if the failure happened during a write.
      const saved = requireCourse(course.id);
      delete saved.pending;
      saved.error = error instanceof Error ? error.message : String(error);
      save(saved);
    } finally {
      running.delete(course.id);
      if (!ctx.signal.aborted) notify(course);
    }
  }

  function start(course) {
    if (running.has(course.id) || (!course.planNodes && course.lessons.length === course.topics.length)) return;
    running.add(course.id);
    notify(course);
    void prepare(course).catch(error => console.error("[offline-plans]", error));
  }

  function recent() {
    return readdirSync(directory)
      .filter(name => /^[a-f0-9]{64}\.json$/.test(name))
      .map(name => read(name.slice(0, -5)))
      .filter(Boolean)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(course => summarize(course, running.has(course.id)));
  }

  ctx.workers.register({
    id: outlineWorker, instructions: outlineInstructions, resultSchema: outlineSchema,
    validateResult(outline, { input }) {
      const course = requireCourse(input.courseId);
      groupLessons(course.planNodes, outline, statedLessonCount(course.presentation));
    },
  });
  ctx.workers.register({ id: workerId, instructions, resultSchema: lessonSchema, validateResult: validateLesson });
  ctx.handle("list", recent);
  ctx.handle("make", ({ sessionId, context = "", presentation = "" }) => {
    if (typeof sessionId !== "string") throw new Error("Choose a teaching session.");
    const session = ctx.learning.getSession(sessionId);
    if (!session?.tree?.nodes.length || session.kind === "practice") throw new Error("Save a teaching plan first.");
    if (typeof presentation !== "string" || presentation.length > 16000 || typeof context !== "string" || context.length > 12000) {
      throw new Error("Invalid plan context.");
    }
    const { id, topics } = capturePlan(session.id, session.tree, presentation);
    const existing = read(id);
    if (existing) return { id };
    const course = {
      version: 1, id, sessionId, title: session.title, planNodes: topics, presentation, topics: [], createdAt: new Date().toISOString(),
      context, lessons: [], completed: 0, answers: {},
    };
    save(course);
    start(course);
    return { id };
  });
  ctx.handle("resume", ({ id }) => {
    start(requireCourse(id));
    return {};
  });
  ctx.handle("lesson", ({ id, index }) => {
    if (!Number.isSafeInteger(index) || index < 0) throw new Error("Invalid lesson.");
    return studyLesson(requireCourse(id), index);
  });
  ctx.handle("answer", ({ id, lesson, check, followUp, value }) => {
    if (!Number.isSafeInteger(lesson) || lesson < 0 || !Number.isSafeInteger(check) || check < 0
      || typeof followUp !== "boolean" || typeof value !== "string") throw new Error("Invalid answer.");
    const course = requireCourse(id);
    recordAnswer(course, { lesson, check, followUp, value });
    save(course);
    return studyLesson(course, lesson);
  });
  ctx.handle("complete", ({ id, index }) => {
    if (!Number.isSafeInteger(index) || index < 0) throw new Error("Invalid lesson.");
    const course = requireCourse(id);
    completeLesson(course, index);
    checkpoint(course);
    return summarize(course, false);
  });
  ctx.handle("review", ({ id }) => {
    const course = requireCourse(id);
    return course.topics.slice(0, course.completed).flatMap((topic, index) => {
      const lesson = studyLesson(course, index);
      return lesson.checks.flatMap(check => check.answer?.correct === false
        ? [{ index, topic: topic.title, question: check.question }] : []);
    });
  });
}
