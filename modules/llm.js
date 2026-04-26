// modules/llm.js
// Single LLM provider: local Ollama (gpt-oss:120b-cloud). This file exists so
// call sites are provider-agnostic — swapping to another backend later only
// requires editing this file.

module.exports = require('./ollama');
