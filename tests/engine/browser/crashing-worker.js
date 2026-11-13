// A worker that starts, says it is ready and then fails on its first request
// (browser test: the client must do the unfinished work again on the main thread).
self.onmessage = function () { throw new Error('this worker crashes on purpose'); };
self.postMessage({ type: 'ready', version: 'crash-test' });
