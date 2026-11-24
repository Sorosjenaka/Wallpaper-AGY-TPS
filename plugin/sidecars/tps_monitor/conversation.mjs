import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

let database;

export function desktopConversation(title, appData) {
  if (typeof title !== 'string' || !title.trim() || title.length > 240 || !appData) return null;
  const path = join(appData, 'conversation_summaries.db');
  if (!existsSync(path)) return null;
  try {
    if (database?.path !== path) {
      const connection = new DatabaseSync(path, { readOnly: true });
      connection.exec('PRAGMA busy_timeout=100');
      database?.connection.close();
      database = { path, connection };
    }
    const matches = database.connection.prepare(
      'SELECT conversation_id FROM conversation_summaries WHERE title = ? COLLATE NOCASE LIMIT 2'
    ).all(title.trim());
    return matches.length === 1 ? matches[0].conversation_id : null;
  } catch {
    return null;
  }
}
