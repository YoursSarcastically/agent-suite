/**
 * Inference worker.
 *
 * Everything the engine does - the WebGPU dispatches, the grammar-constrained
 * sampling loop, the JSON accumulation - ran on the main thread until this
 * file existed. On a 3B model at ~10 tokens/sec that is twenty to fifty seconds
 * of a blocked event loop per agent call, which is why the progress bar froze
 * mid-run and the Stop button often would not take a click. The work was
 * genuinely happening; the page just could not paint or listen while it did.
 *
 * Moving it here costs one file and a message boundary, and the main thread
 * gets to stay at 60fps while a model generates.
 */

import { WebWorkerMLCEngineHandler } from "https://esm.run/@mlc-ai/web-llm";

const handler = new WebWorkerMLCEngineHandler();
self.onmessage = (msg) => handler.onmessage(msg);
