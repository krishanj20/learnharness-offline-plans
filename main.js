const viewId = "study";

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function hasPlan(message) {
  return message.parts.some(part =>
    (part.type === "data-plan-block" && part.data?.nodes?.length)
    || (part.type === "tool-plan_init" && part.state === "output-available" && part.output?.tree?.nodes?.length));
}

export function snapshotText(transcript) {
  const prose = message => message?.parts.filter(part => part.type === "text")
    .map(part => part.text).join("\n") ?? "";
  const plan = transcript.findLast(hasPlan);
  const request = transcript.find(message => message.role === "user");
  return {
    presentation: [prose(request).slice(0, 4000), prose(plan).slice(-11999)].join("\n"),
    context: transcript.map(message => prose(message)).filter(Boolean).join("\n").slice(-12000),
  };
}

export function activate(ctx) {
  let preferredCourse;
  ctx.registerAction({
    id: "make-offline",
    name: "Make available offline",
    disabled: ({ view }) => !view || view.busy || view.reconciliation !== "ready"
      || !view.transcript.some(hasPlan),
    async run({ sessionId, view }) {
      ({ id: preferredCourse } = await ctx.call("make", { sessionId, ...snapshotText(view.transcript) }));
      if (ctx.signal.aborted) return;
      ctx.app.openView(viewId);
    },
  });
  ctx.placeAction({ id: "teaching", actionId: "make-offline", location: "top-bar", sessions: ["teaching"] });
  ctx.registerAction({
    id: "open-library",
    name: "Offline plans",
    run() {
      preferredCourse = undefined;
      ctx.app.openView(viewId);
    },
  });
  ctx.placeAction({ id: "library", actionId: "open-library", location: "sidebar" });

  ctx.registerView({
    id: viewId, name: "Offline plans",
    mount(container, signal) {
      let course;
      let index;
      let showReview = false;
      let busy = false;
      let revision = 0;
      let markdown = [];
      const root = element("section", undefined, "offline-plans");
      const notice = element("p", undefined, "offline-plans-error");
      notice.setAttribute("role", "alert");
      const body = element("div");
      root.append(notice, body);
      container.append(root);

      function resetBody() {
        markdown.forEach(widget => widget.dispose());
        markdown = [];
        body.replaceChildren();
      }

      function prose(parent, text) {
        const block = element("div", undefined, "offline-plans-prose");
        parent.append(block);
        markdown.push(ctx.ui.mountMarkdown(block, { text }, { signal }));
      }

      function report(error) {
        if (!signal.aborted) notice.textContent = error instanceof Error ? error.message : String(error);
      }

      function button(label, action, primary = false) {
        const node = element("button", label, primary ? "offline-plans-primary" : undefined);
        node.type = "button";
        node.addEventListener("click", async () => {
          if (busy || signal.aborted) return;
          busy = true;
          const enabled = [...body.querySelectorAll("button:not(:disabled)")];
          for (const button of enabled) button.disabled = true;
          notice.textContent = "";
          try { await action(); } catch (error) { report(error); }
          finally {
            busy = false;
            for (const button of enabled) button.disabled = false;
          }
        });
        return node;
      }

      function status(item) {
        if (item.outlining) return "Organizing the lessons in your plan";
        if (item.status === "ready") return `${item.completed} of ${item.topics.length} lessons completed`;
        return `${item.prepared} of ${item.topics.length} lessons prepared`;
      }

      async function open(item, target) {
        course = item;
        index = target ?? Math.max(0, Math.min(item.completed, item.topics.length - 1));
        showReview = item.status === "ready" && item.completed === item.topics.length && target === undefined;
        await refresh(true);
      }

      function heading(text, focus) {
        const title = element("h1", text);
        title.tabIndex = -1;
        body.append(title);
        if (focus) title.focus();
      }

      function renderLibrary(items, focus) {
        heading("Offline plans", focus);
        if (!items.length) {
          body.append(element("p", "Open a teaching plan and choose Make available offline to prepare your first course."));
          return;
        }
        const list = element("ul", undefined, "offline-plans-library");
        for (const item of items) {
          const row = element("li");
          row.append(button(item.title, () => open(item)), element("span", status(item)));
          list.append(row);
        }
        body.append(list);
      }

      function paintQuestion(parent, question, check, followUp, canAnswer) {
        const group = element("section", undefined, "offline-plans-question");
        const field = element("fieldset");
        const legend = element("legend");
        field.append(legend);
        prose(legend, question.question);
        const choices = element("div", undefined, "offline-plans-choices");
        for (const option of question.options) {
          const choice = button(option.label, async () => {
            await ctx.call("answer", { id: course.id, lesson: index, check, followUp, value: option.value });
            await refresh(false, `answer-${check}-${followUp}`);
          });
          if (question.answer?.value === option.value) choice.setAttribute("aria-pressed", "true");
          choice.disabled = !!question.answer || !canAnswer;
          choices.append(choice);
        }
        field.append(choices);
        group.append(field);
        parent.append(group);
        if (question.answer) {
          const feedback = element("div", undefined, "offline-plans-feedback");
          feedback.dataset.offlineFeedback = `answer-${check}-${followUp}`;
          feedback.tabIndex = -1;
          feedback.append(element("strong", question.answer.correct ? "Correct" : `Correct answer — ${question.answer.solution}`));
          prose(feedback, question.answer.feedback);
          group.append(feedback);
        }
      }

      async function refresh(focus = false, feedbackTarget) {
        const request = ++revision;
        const list = await ctx.call("list");
        if (signal.aborted || request !== revision) return;
        const current = list.find(item => item.id === course?.id);
        let lesson;
        let misses;
        if (current?.status === "ready") {
          if (showReview) misses = await ctx.call("review", { id: current.id });
          else lesson = await ctx.call("lesson", { id: current.id, index });
        }
        if (signal.aborted || request !== revision) return;
        course = current;
        resetBody();
        if (!course) return renderLibrary(list, focus);
        body.append(button("All offline plans", async () => {
          course = undefined;
          await refresh(true);
        }));
        if (course.status !== "ready") {
          heading(course.title, focus);
          const progress = element("p", status(course));
          progress.setAttribute("role", "status");
          body.append(progress);
          if (course.status === "preparing") {
            body.append(element("p", "Keep LearnHarness open while it prepares your course."));
          } else {
            if (course.error) body.append(element("p", course.error, "offline-plans-error"));
            body.append(button("Resume preparation", async () => {
              await ctx.call("resume", { id: course.id });
              await refresh();
            }, true));
          }
          return;
        }
        if (showReview) {
          heading(course.title, focus);
          body.append(element("p", status(course)));
          const results = element("div", undefined, "offline-plans-review");
          results.append(element("h2", "Questions to revisit"));
          if (!misses.length) results.append(element("p", "You answered every check correctly."));
          for (const miss of misses) {
            const row = element("section");
            row.append(button(miss.topic, () => open(course, miss.index)));
            prose(row, miss.question);
            results.append(row);
          }
          results.append(button("Review from the beginning", () => open(course, 0)));
          body.append(results);
          return;
        }

        body.append(element("p", `${course.title} · Lesson ${index + 1} of ${course.topics.length}`, "offline-plans-meta"));
        heading(lesson.title, focus);
        if (course.completed === 0 && index === 0 && lesson.checks.every(check => !check.answer)) {
          body.append(element("p", "Ready offline", "offline-plans-meta"));
        }
        prose(body, lesson.explanation);
        body.append(element("h2", "Worked example"));
        prose(body, lesson.example);
        body.append(element("h2", "Check your understanding"));
        const canAnswer = index === course.completed;
        for (const [checkIndex, question] of lesson.checks.entries()) {
          paintQuestion(body, question, checkIndex, false, canAnswer);
          if (question.followUp) {
            body.append(element("h3", "Another worked example"));
            prose(body, question.alternateExample);
            body.append(element("h3", "Try another (optional)"));
            paintQuestion(body, question.followUp, checkIndex, true, canAnswer);
          }
        }
        const navigation = element("nav", undefined, "offline-plans-nav");
        navigation.setAttribute("aria-label", "Lesson navigation");
        if (index > 0) navigation.append(button("Previous lesson", () => open(course, index - 1)));
        const last = index === course.topics.length - 1;
        const next = button(last ? (canAnswer ? "Finish course" : "Review results") : "Continue", async () => {
          const updated = canAnswer ? await ctx.call("complete", { id: course.id, index }) : course;
          await open(updated, last ? undefined : index + 1);
        }, true);
        next.disabled = lesson.checks.some(check => !check.answer);
        navigation.append(next);
        body.append(navigation);
        if (feedbackTarget) body.querySelector(`[data-offline-feedback="${feedbackTarget}"]`)?.focus();
      }

      const unsubscribe = ctx.onNotification(event => {
        if (event.topic === "course-changed" && (!course || course.status !== "ready")) {
          void refresh().catch(report);
        }
      });
      const resync = ctx.onResync(() => void refresh().catch(report));
      async function load() {
        if (preferredCourse) {
          const target = preferredCourse;
          preferredCourse = undefined;
          const list = await ctx.call("list");
          if (signal.aborted) return;
          const item = list.find(item => item.id === target);
          if (item) return open(item);
        }
        return refresh();
      }
      void load().catch(report);
      return () => {
        unsubscribe();
        resync();
        resetBody();
        root.remove();
      };
    },
  });
}
