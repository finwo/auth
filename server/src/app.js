import Router from 'router';

export const app = new Router();
app.manifest = [];
app.history = [];

globalThis.app = app;

export default app;
