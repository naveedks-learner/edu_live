CREATE TABLE transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  question TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  path_taken TEXT NOT NULL,
  confidence REAL,
  retrieval_json TEXT NOT NULL,
  llm_input TEXT NOT NULL,
  llm_output TEXT NOT NULL,
  jev_input_json TEXT,
  jev_output_json TEXT,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  jev_cost_usd REAL NOT NULL DEFAULT 0,
  llm_cost_usd REAL NOT NULL DEFAULT 0
);

CREATE INDEX idx_transactions_timestamp ON transactions(timestamp);
