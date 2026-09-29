/** Real SQLite statements and atomic batches, with the D1 shape used by Drizzle. */
export function sqliteD1(database) {
  class Statement {
    constructor(sql, args = []) { this.sql = sql; this.args = args; }
    bind(...args) { return new Statement(this.sql, args); }
    execute() { return { success: true, results: database.prepare(this.sql).all(...this.args) }; }
    async all() { return this.execute(); }
    async raw() { const stmt = database.prepare(this.sql); stmt.setReturnArrays(true); return stmt.all(...this.args); }
    async first() { return database.prepare(this.sql).get(...this.args) ?? null; }
    async run() { return database.prepare(this.sql).run(...this.args); }
  }
  return {
    prepare: (sql) => new Statement(sql),
    async batch(statements) {
      database.exec('BEGIN');
      try {
        const result = statements.map((statement) => statement.execute());
        database.exec('COMMIT');
        return result;
      } catch (error) { database.exec('ROLLBACK'); throw error; }
    },
  };
}
