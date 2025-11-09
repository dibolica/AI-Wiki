# AI-Wiki Server (ELI5 via Ollama)

## 1) Install & run Ollama
- https://ollama.com/download
- Pull a small instruct model (good quality + fast):
  - `ollama pull llama3.1:8b-instruct`   # as used in .env
  - (alternatives: `qwen2.5:7b-instruct`, `mistral:7b-instruct`)

Make sure Ollama is running (default at `http://localhost:11434`).

## 2) Install and run server
