# Template runtime proof of concept

This directory is an isolated prototype for the template package runtime. It does not change the production apps.

## Run

```sh
npm install
npm run build
npm start
```

Open `http://localhost:4173`.

OPFS requires a secure context. On plain HTTP hosts other than localhost, the PoC falls back to an in-memory cache and logs a warning. Use localhost or HTTPS to exercise OPFS persistence.

## The proof

- `.tar.gz` packages built with `modern-tar`.
- Content-addressed layers stored in OPFS.
- Arbitrary ordered overlay layers, with the last layer winning per file.
- HBS pages and partials from the merged layer stack.
- `template://` CSS and image links resolved to object URLs.
- CSS `@import` and `url()` rewriting across layers.
- Handlebars rendering with delegated behavior and no Mithril.
- Sanitized template output with scripts and external assets rejected.
- Cache reuse across reloads.

## Demo layers

- `system` is the complete base package.
- `acme-brand` overrides the topbar partial and global color tokens.
- `acme-holiday` overrides the login page and login CSS.
- Both overlays can be enabled together to demonstrate three-layer resolution.

## Runtime layout

```text
src/main.ts                 demo state and behavior
src/runtime/cache.ts        OPFS layers, composites and metadata
src/runtime/tar.ts          download, digest check and extraction
src/runtime/layers.ts       layer merge and page resolution
src/runtime/assets.ts       template:// and CSS asset rewriting
src/runtime/render.ts       Handlebars compilation and partials
src/runtime/actions.ts      delegated actions, forms and routes
src/runtime/router.ts       hash based demo router
```

## Limits

- PoC icons are inline SVG.
- The production template build should generate Lucide SVG files and reference those from templates instead of embedding SVG in HBS.
- Client-specific overlays are not part of the backend plan yet.
- The production manifest endpoint, upload API, storage and admin UI are not implemented here.
