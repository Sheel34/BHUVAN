# BHUVAN Prompting Playbook

Use this project to learn prompting in small, testable loops instead of asking for giant one-shot generations.

## 1. Architecture-First Prompt

```text
I have an existing React + Three.js terrain simulation and I want to evolve it into a real landing-safety decision-support prototype.
Do not suggest a rewrite.
Give me 3 architecture options that preserve the current frontend, rank them by realism and speed, and tell me what would look fake to an interviewer.
```

## 2. File-Scoped Refactor Prompt

```text
Here is my current App.jsx.
Refactor it from intro/orbital/descent into intro/analyze/inspect3d/descent/report.
Keep React hooks, preserve the existing scene canvas, and show the exact code edits only.
```

## 3. Backend Contract Prompt

```text
Design a minimal FastAPI contract for terrain analysis.
I need sample catalog, analyze-sample, and analyze-upload endpoints.
The response must include elevation, slope, roughness, hazard, traversability, and ranked landing zones.
Keep the payload simple enough for a React frontend to consume directly.
```

## 4. Critique Prompt

```text
Critique this feature brutally.
Point out what is real problem-solving, what is demo theater, what is missing evidence, and which claims I should avoid making.
```

## 5. Verification Prompt

```text
Given these changed files, tell me the most likely runtime bugs, integration issues, and edge cases.
Prioritize the bugs that would actually break the demo.
```

## Rules For Yourself

- Ask for one file or one interface at a time.
- Always ask for trade-offs, not just a preferred answer.
- Ask the model what would make the work look fake or shallow.
- End implementation prompts with a verification request.
