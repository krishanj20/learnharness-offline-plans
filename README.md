# Offline plans

Prepare a course from a saved LearnHarness teaching plan. The configured teaching model
groups the concepts into the lessons promised by the tutor and prepares one worked example
and a short set of checks for each lesson. Extra examples appear after a wrong answer.
The app saves the course and study progress locally. Once the course is ready, studying
it requires only the running LearnHarness app.

## Build and install

Download [Offline Plans v0.2.1](https://github.com/krishanj20/learnharness-offline-plans/releases/tag/v0.2.1). From the release ZIP, extract the `offline-plans` folder into the directory shown in
**Settings → Community plugins**. Choose **Refresh plugins**, then enable **Offline plans**.

To build from source, use Node 26 in the plugin project directory:

```sh
npm ci
npm test
npm run build
npm run install:local -- "<plugins-directory>"
```

The installer copies the built package and preserves existing study data. Restart
LearnHarness after updating an enabled copy.

## Study

1. Teaching sessions use the live tutor by default. To prepare a particular plan, open
   the teaching session and choose **Make available offline** in the toolbar or its overflow menu.
2. Keep LearnHarness open while the lessons are prepared. Use **Resume preparation**
   after an interruption. Saved lesson content is reused.
3. Open **Offline plans** from the sidebar. Work through the explanations, examples
   and checks. An incorrect answer reveals feedback, another example and an optional
   follow-up. At the end, **Questions to revisit** lists the checks you missed.
