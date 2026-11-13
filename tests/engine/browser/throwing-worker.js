// A worker that fails while starting (browser test: the client must fall back to the main thread).
throw new Error('this worker fails on purpose');
