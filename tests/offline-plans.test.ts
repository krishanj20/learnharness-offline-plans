import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Value } from "typebox/value";
import { snapshotText } from "../main.js";
import { activate } from "../backend.mjs";
import { capturePlan, groupLessons, statedLessonCount, lessonSchema, validateLesson } from "../course.mjs";

const nodes = [
  { id: "conditional", title: "Conditional probability" },
  { id: "intersection", title: "Intersections" },
  { id: "fractions", title: "Fractions" },
];
const edges = [{ from: "fractions", to: "conditional" }, { from: "intersection", to: "conditional" }];
const original = { nodes, edges };
const question = {
  question: "What is one half as a percentage?",
  options: [
    { label: "50%", value: "a", feedback: "Multiply one half by 100." },
    { label: "2%", value: "b", feedback: "Two is the denominator. Divide one by two before multiplying by 100." },
  ],
  correctAnswer: "a",
};
const check = {
  ...question,
  alternateExample: "If three of six people voted yes, three divided by six is one half.",
  followUp: { ...question, question: "What share is two out of four?" },
};
const lesson = { explanation: "A fraction divides the numerator by the denominator.", example: "One out of two equals 0.5.", checks: [check, { ...check, question: "What share is four out of eight?" }] };

test("plan snapshot has unique topics in prerequisite order and is tied to the source session", () => {
  const capture = capturePlan("chat_offline", original);
  assert.deepEqual(capture.topics.map(topic => topic.id), ["intersection", "fractions", "conditional"]);
  assert.equal(capturePlan("chat_offline", { nodes, edges: [...edges].reverse() }).id, capture.id);
  assert.notEqual(capturePlan("chat_other", original).id, capture.id);
  assert.notEqual(capturePlan("chat_offline", { nodes, edges: edges.slice(0, 1) }).id, capture.id);
  assert.throws(() => capturePlan("chat_offline", { nodes, edges: [...edges, { from: "conditional", to: "fractions" }] }), /circular/);
});

test("a lesson can contain multiple concepts while preserving cross-lesson prerequisites", () => {
  const { topics } = capturePlan("chat_offline", original);
  const one = { title: "Probability", nodeIds: topics.map(t => t.id) };
  assert.equal(groupLessons(topics, { lessons: [one] }).length, 1);
  const split = [{ title: "Counting", nodeIds: ["fractions", "intersection"] },
    { title: "Given an event", nodeIds: ["conditional"] }];
  assert.equal(statedLessonCount("We’ll use one short lesson with a worked example."), 1);
  assert.equal(statedLessonCount("Make a three-lesson plan."), 3);
  assert.equal(statedLessonCount("In one lesson we will practice substitution."), undefined);
  assert.throws(() => groupLessons(topics, { lessons: split }, 1), /lesson count/);
  assert.deepEqual(groupLessons(topics, { lessons: split })[1].prerequisites, ["lesson-1"]);
  assert.throws(() => groupLessons(topics, { lessons: split.toReversed() }), /prerequisite/);
  assert.throws(() => groupLessons(topics, { lessons: split.slice(0, 1) }), /omits/);
  assert.throws(() => groupLessons(topics, { lessons: [one, one] }), /once/);
});

test("lesson validation requires real content fields, known keys and feedback", () => {
  assert.equal(Value.Check(lessonSchema, lesson), true);
  assert.equal(Value.Check(lessonSchema, { ...lesson, example: undefined }), false);
  validateLesson(lesson);
  assert.throws(() => validateLesson({ ...lesson, example: "  " }), /worked example/);
  assert.throws(() => validateLesson({ ...lesson, example: "![Diagram](https://invalid.local/image)" }), /worked example/);
  assert.throws(() => validateLesson({ ...lesson, checks: [{ ...check, correctAnswer: "z" }] }), /does not match/);
  assert.throws(() => validateLesson({ ...lesson, checks: [{
    ...check, options: [check.options[0], { ...check.options[1], feedback: "  " }],
  }] }), /specific feedback/);
});

test("resume only generates unfinished topics, including the gap after the worker saves a result", async t => {
  const directory = mkdtempSync(join(tmpdir(), "offline-plans-test-"));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  let controller = new AbortController();
  let tree = original;
  let interruptAfterResult = true;
  const calls: string[] = [];
  const tasks: { id: string; requestId: string; status: string; result?: unknown }[] = [];
  const handlers = new Map<string, (input?: any) => any>();
  const source = { id: "chat_offline", title: "Probability", messages: [] };
  function load() {
    activate({
      dataDirectory: directory,
      signal: controller.signal,
      learning: { getSession: () => ({ ...source, tree }) },
      inference: { catalog: async () => ({ slots: { strong: { model: { provider: "custom", id: "fixture" } } } }) },
      events: { emit() {} },
      handle(name: string, handler: (input?: any) => any) { handlers.set(name, handler); },
      workers: {
        register() {},
        list: () => tasks,
        start(_id: string, request: { requestId: string; input: { topicId: string } }) {
          calls.push(_id === "group-lessons" ? "outline" : request.input.topicId);
          const outline = { title: "Probability", lessons: ["intersection", "fractions", "conditional"].map(id =>
            ({ title: nodes.find(n => n.id === id)!.title, nodeIds: [id] })) };
          const task = { id: String(tasks.length), requestId: request.requestId, status: "succeeded", result: _id === "group-lessons" ? outline : lesson };
          tasks.push(task);
          return task;
        },
        async wait(id: string) {
          if (id === "2" && interruptAfterResult) controller.abort();
          return tasks[Number(id)];
        },
      },
    });
  }
  const call = (name: string, input?: any) => handlers.get(name)!(input);
  const settle = () => new Promise<void>(resolve => setImmediate(resolve));
  load();
  assert.deepEqual(call("list"), []);
  assert.deepEqual(tasks, []);
  const { id } = call("make", { sessionId: source.id });
  assert.equal(call("make", { sessionId: source.id }).id, id);
  await settle();
  assert.equal(call("list")[0].prepared, 1);
  assert.deepEqual(calls, ["outline", "lesson-1", "lesson-2"]);
  interruptAfterResult = false;
  controller = new AbortController();
  tree = { nodes: nodes.slice(0, 1), edges: [] };
  load();
  call("resume", { id });
  call("resume", { id });
  await settle();
  assert.deepEqual(calls, ["outline", "lesson-1", "lesson-2", "lesson-3"]);
  assert.deepEqual(call("list").map((course: { status: string }) => course.status), ["ready"]);
  const at = { id, index: 0 };
  assert.throws(() => call("complete", at), /each check/);
  const firstAnswer = { id, lesson: 0, check: 0, followUp: false, value: "b" };
  assert.equal(call("lesson", at).checks[0].answer, undefined);
  assert.equal(call("lesson", at).checks[0].followUp, undefined);
  const wrong = call("answer", firstAnswer).checks[0];
  assert.equal(wrong.answer.correct, false);
  assert.match(wrong.answer.feedback, /denominator/);
  assert.equal(wrong.followUp.question, check.followUp.question);
  load();
  assert.deepEqual(call("lesson", at).checks[0], wrong);
  assert.equal(call("answer", firstAnswer).checks[0].answer.correct, false);
  assert.throws(() => call("answer", { ...firstAnswer, value: "a" }), /already settled/);
  assert.equal(call("answer", { ...firstAnswer, check: 1, value: "a" }).checks[1].answer.correct, true);
  assert.equal(call("complete", at).completed, 1);
  assert.equal(call("complete", at).completed, 1);
  assert.deepEqual(call("review", { id }), [{ index: 0, topic: "Intersections", question: check.question }]);
});

test("the public transcript supplies plan prose without draft answers or internal reasoning", () => {
  const snapshot = snapshotText([
    {role: "user", parts: [{type: "text", text: "A one-lesson plan"}]},
    {role: "assistant", parts: [{type: "reasoning", text: "private reasoning"},
      {type: "text", text: "We will use one short lesson."}, {type: "data-plan-block", data: {nodes: [{}]}}]},
    {role: "assistant", parts: [{type: "text", text: "Later teaching"}]},
  ]);
  assert.match(snapshot.presentation, /one short lesson/);
  assert.doesNotMatch(snapshot.presentation, /Later teaching|private reasoning/);
  assert.match(snapshot.context, /Later teaching/);
  assert.doesNotMatch(snapshot.context, /private reasoning/);
});
