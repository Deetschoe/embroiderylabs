// A worker that loads but never says it is ready (browser test: the client must give up and use the main thread).
self.onmessage = function () {};
