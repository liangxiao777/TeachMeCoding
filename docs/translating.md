# Contributing UI translations

English · [简体中文](translating.zh.md)

The UI currently supports English (`en`) and Simplified Chinese (`zh-CN`). English is the canonical source and runtime fallback language. Resources ship with the application build and do not depend on an online translation platform. Translations are reviewed through ordinary Git branches and Pull Requests; dictionaries are not written back at runtime.

## Translation scope

Translate page actions, navigation, statuses, empty states, accessible names, first-party domain errors, and date and number formatting. Asynchronous failures, host receipts after a reload, automatic approval warnings, and execution summaries are also UI text.

Do not translate user input or names, Agent-generated content, third-party Provider/MCP/Skill information, program stdout/stderr, or original feedback and evidence in courses and learning records. Questions and answers in the requirements form are editable learning content; do not translate them using text-based heuristics. Host-generated default conversation titles are stored only as empty values. At display time, they are derived from the scope and whether this is the first conversation in that scope; later conversations with empty titles display “New conversation” (“新会话” in Simplified Chinese). Any nonempty title is displayed as stored. Quotes retain the semantic kind of their caption and the original name. The UI translates only host labels such as “Lesson”, “Exercise”, “Selected code”, and “Terminal output”; captured label and text values are not rewritten. Quotes without a caption keep their original label. Receipts are linked only through receiptId, never by matching message text.

Language priority is: the choice saved in the current browser → the first supported language in the browser's language list → English. Regional English tags map to `en`; `zh`, `zh-CN`, `zh-SG`, and an explicit `zh-Hans` map to Simplified Chinese. Traditional Chinese preferences are not automatically treated as Simplified Chinese. Language options in settings use each language's own name. Choosing “Follow browser” clears the explicit preference. Other choices are saved only in the current browser's `tmc-language`; they do not write to the database, change the teaching model's language, or reload the learning page.

## Updating existing translations

Resources are in `apps/web/src/i18n/locales/<locale>/<namespace>.json`:

- `common`: Shared actions, document metadata, common controls, and current client notices.
- `home`, `settings`, `learning`, `workbench`, `assessment`, `library`: Feature pages.
- `errors`: Display text for first-party domain error codes, not arbitrary upstream errors.

Find the semantic key used by the page before editing the corresponding JSON. Do not use English sentences as keys, or merge keys from different contexts just because they currently use the same wording. When changing a feature or adding text, update English and all other supported languages in the same PR. When removing text, also remove keys that are no longer used.

Preserve interpolation names such as `{{title}}`; their positions may change to match word order. Do not assemble sentences from fragments, translate interpolated content, or put credentials, exception stacks, or upstream responses into interpolations. For quantities, use i18next's `count` and the language's plural forms: for example, English uses `fileCount_one`/`fileCount_other`, while Chinese needs only `fileCount_other`. Use the existing `Intl` formatters for numbers, dates, and relative times rather than hard-coding regional formats in components.

Use `useTranslation` in React components and the initialized i18n instance in pure presentation functions. Keep current error and success notices as `notice(namespace, key, values)` or the original `ApiError`, and call `formatNotice` only when rendering. Do not store translated strings in state inside asynchronous callbacks. This lets existing notices update when the language changes.

HTTP errors return only the status code, a stable domain `code`, and scalar `params` safe for public disclosure, not display text. New domain errors must declare a code and add text in both languages. Status events, run/conversation results, `issue` values in model configurations, `issues` in requirements confirmation, and execution records use the same semantic object. Do not add a second set of fields such as `errorDetail`/`issueDetail` or flatten these objects into strings prematurely in the frontend. Unknown codes, errors without metadata, and native network exceptions display a generic failure notice in the current language; arbitrary `Error.message` values are not UI text. Explicit third-party diagnostics and program output remain raw data. Do not put language keys in the database, Agent tool inputs, or persisted SSE events: persist domain semantics, not dictionary paths. Host assessment summaries derive only from `result` and `execution`; model-authored `needs_work` feedback remains unchanged. Host receipts store only operation facts and associations, and host notices for file operations must not be mixed into program `output`.

## Adding a language

Copy all namespace files from the English directory, translate them, and submit them. Do not publish untranslated English copies as a supported language. Register resources in `resources.ts`, declare the language and explicit browser tag mappings in `locale.ts`, then add the language's own name to settings. Handle script and regional differences explicitly rather than merging them by default. The current UI uses a left-to-right layout. Adding an RTL language requires separate layout work and browser acceptance testing, not just a dictionary.

## PR checks

```sh
pnpm check:i18n
pnpm check
pnpm --filter @teach-me-coding/web test
pnpm build
pnpm test:browser tests/browser/i18n.spec.ts --workers=1
```

`check:i18n` checks that namespaces and semantic keys match English, strings are nonempty, interpolations are consistent, and plural categories match the language. It also uses the TypeScript AST to check first-party UI code for direct text, Chinese outside dictionaries, and reintroduction of removed text generators, duplicate fields, or error constructors. Brands, language names in their own language, keyboard key names, encodings, and other technical names remain unchanged; command argument examples explicitly use HTML's `translate="no"`. The check does not judge translation quality, scan course or Agent content, or limit text length. TypeScript infers key types from the English resources. Lightweight GitHub Actions check dictionaries and source code, frontend types, and frontend unit tests. CI does not call models or external translation services.

Describe affected pages, terminology choices, and exceptions in the PR, and attach screenshots of actual pages in both the default language and the added or updated language. Manually check natural phrasing, terminology consistency, truncated buttons, line wrapping, dialogs, empty states, error states, and narrow screens. Also verify that original user and Agent content has not been translated. Browser regression tests use disposable data and real PTYs, and model scenarios use a deterministic Provider. They do not read or write personal learning directories. Chinese browser regressions explicitly pin `zh-CN`; multilingual cases specify their own locale rather than relying on the developer's machine language.

In development mode, also run a dictionary-marker check: replace only the browser's English resources, without adding a production debug switch. Open settings pages and dialogs one by one and check that visible text and accessibility attributes go through the dictionary. Deliberately insert an untranslated button to confirm the check catches omissions. Validate production builds with the normal dictionaries. For unknown domain codes, plain-text responses, and native network failures, verify that only the generic notice in the current language is displayed.
