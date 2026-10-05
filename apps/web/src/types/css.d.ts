// Global stylesheets are imported for their side effects only (bundled by
// Next.js/Tailwind). They export nothing, so a named or default import from
// a plain `.css` file stays a type error; CSS modules keep their own typing.
declare module "*.css" {}
