ALTER TABLE `learning_journal_settings` ADD `event_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `learning_journal_settings` ADD `storage_bytes` integer DEFAULT 0 NOT NULL;

--> statement-breakpoint
/* Count retained deletion markers and UTF-8 text, with 128 bytes of row overhead.
   Reserve each day deletion timestamp up front so privacy deletion cannot grow usage.
   Existing oversized accounts keep reads and shrinking/deletion operations. */
INSERT OR IGNORE INTO learning_journal_settings (user_key) SELECT user_key FROM learning_journal_events UNION SELECT user_key FROM learning_journal_days;
--> statement-breakpoint
UPDATE learning_journal_settings SET event_count=(SELECT count(*) FROM learning_journal_events e WHERE e.user_key=learning_journal_settings.user_key), storage_bytes=COALESCE((SELECT sum(128+length(CAST(COALESCE(user_key,'') || COALESCE(event_id,'') || COALESCE(date,'') || COALESCE(timezone,'') || COALESCE(occurred_at,'') || COALESCE(kind,'') || COALESCE(title,'') || COALESCE(summary,'') || COALESCE(ref_ids,'') || COALESCE(counts,'') || COALESCE(content_hash,'') AS BLOB))) FROM learning_journal_events e WHERE e.user_key=learning_journal_settings.user_key),0)+COALESCE((SELECT sum(152+length(CAST(COALESCE(user_key,'') || COALESCE(date,'') || COALESCE(facts_summary,'') || COALESCE(edited_summary,'') || COALESCE(updated_at,'') AS BLOB))) FROM learning_journal_days d WHERE d.user_key=learning_journal_settings.user_key),0);
--> statement-breakpoint
CREATE TRIGGER learning_journal_events_usage_insert AFTER INSERT ON learning_journal_events
BEGIN
  INSERT INTO learning_journal_settings (user_key) VALUES (NEW.user_key) ON CONFLICT(user_key) DO NOTHING;
  UPDATE learning_journal_settings SET storage_bytes=storage_bytes+(128+length(CAST(COALESCE(NEW.user_key,'') || COALESCE(NEW.event_id,'') || COALESCE(NEW.date,'') || COALESCE(NEW.timezone,'') || COALESCE(NEW.occurred_at,'') || COALESCE(NEW.kind,'') || COALESCE(NEW.title,'') || COALESCE(NEW.summary,'') || COALESCE(NEW.ref_ids,'') || COALESCE(NEW.counts,'') || COALESCE(NEW.content_hash,'') AS BLOB))), event_count=event_count+1 WHERE user_key=NEW.user_key;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM learning_journal_settings WHERE user_key=NEW.user_key AND (storage_bytes>67108864 OR event_count>100000)) THEN RAISE(ABORT,'journal_capacity_exceeded') END;
END;
--> statement-breakpoint
CREATE TRIGGER learning_journal_events_usage_update AFTER UPDATE ON learning_journal_events
BEGIN
  UPDATE learning_journal_settings SET storage_bytes=storage_bytes+(128+length(CAST(COALESCE(NEW.user_key,'') || COALESCE(NEW.event_id,'') || COALESCE(NEW.date,'') || COALESCE(NEW.timezone,'') || COALESCE(NEW.occurred_at,'') || COALESCE(NEW.kind,'') || COALESCE(NEW.title,'') || COALESCE(NEW.summary,'') || COALESCE(NEW.ref_ids,'') || COALESCE(NEW.counts,'') || COALESCE(NEW.content_hash,'') AS BLOB)))-(128+length(CAST(COALESCE(OLD.user_key,'') || COALESCE(OLD.event_id,'') || COALESCE(OLD.date,'') || COALESCE(OLD.timezone,'') || COALESCE(OLD.occurred_at,'') || COALESCE(OLD.kind,'') || COALESCE(OLD.title,'') || COALESCE(OLD.summary,'') || COALESCE(OLD.ref_ids,'') || COALESCE(OLD.counts,'') || COALESCE(OLD.content_hash,'') AS BLOB))) WHERE user_key=NEW.user_key;
  SELECT CASE WHEN (128+length(CAST(COALESCE(NEW.user_key,'') || COALESCE(NEW.event_id,'') || COALESCE(NEW.date,'') || COALESCE(NEW.timezone,'') || COALESCE(NEW.occurred_at,'') || COALESCE(NEW.kind,'') || COALESCE(NEW.title,'') || COALESCE(NEW.summary,'') || COALESCE(NEW.ref_ids,'') || COALESCE(NEW.counts,'') || COALESCE(NEW.content_hash,'') AS BLOB)))>(128+length(CAST(COALESCE(OLD.user_key,'') || COALESCE(OLD.event_id,'') || COALESCE(OLD.date,'') || COALESCE(OLD.timezone,'') || COALESCE(OLD.occurred_at,'') || COALESCE(OLD.kind,'') || COALESCE(OLD.title,'') || COALESCE(OLD.summary,'') || COALESCE(OLD.ref_ids,'') || COALESCE(OLD.counts,'') || COALESCE(OLD.content_hash,'') AS BLOB))) AND EXISTS(SELECT 1 FROM learning_journal_settings WHERE user_key=NEW.user_key AND (storage_bytes>67108864)) THEN RAISE(ABORT,'journal_capacity_exceeded') END;
END;
--> statement-breakpoint
CREATE TRIGGER learning_journal_events_usage_delete AFTER DELETE ON learning_journal_events
BEGIN
  UPDATE learning_journal_settings SET storage_bytes=storage_bytes+-(128+length(CAST(COALESCE(OLD.user_key,'') || COALESCE(OLD.event_id,'') || COALESCE(OLD.date,'') || COALESCE(OLD.timezone,'') || COALESCE(OLD.occurred_at,'') || COALESCE(OLD.kind,'') || COALESCE(OLD.title,'') || COALESCE(OLD.summary,'') || COALESCE(OLD.ref_ids,'') || COALESCE(OLD.counts,'') || COALESCE(OLD.content_hash,'') AS BLOB))), event_count=event_count-1 WHERE user_key=OLD.user_key;
END;
--> statement-breakpoint
CREATE TRIGGER learning_journal_days_usage_insert AFTER INSERT ON learning_journal_days
BEGIN
  INSERT INTO learning_journal_settings (user_key) VALUES (NEW.user_key) ON CONFLICT(user_key) DO NOTHING;
  UPDATE learning_journal_settings SET storage_bytes=storage_bytes+(152+length(CAST(COALESCE(NEW.user_key,'') || COALESCE(NEW.date,'') || COALESCE(NEW.facts_summary,'') || COALESCE(NEW.edited_summary,'') || COALESCE(NEW.updated_at,'') AS BLOB))) WHERE user_key=NEW.user_key;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM learning_journal_settings WHERE user_key=NEW.user_key AND (storage_bytes>67108864)) THEN RAISE(ABORT,'journal_capacity_exceeded') END;
END;
--> statement-breakpoint
CREATE TRIGGER learning_journal_days_usage_update AFTER UPDATE ON learning_journal_days
BEGIN
  UPDATE learning_journal_settings SET storage_bytes=storage_bytes+(152+length(CAST(COALESCE(NEW.user_key,'') || COALESCE(NEW.date,'') || COALESCE(NEW.facts_summary,'') || COALESCE(NEW.edited_summary,'') || COALESCE(NEW.updated_at,'') AS BLOB)))-(152+length(CAST(COALESCE(OLD.user_key,'') || COALESCE(OLD.date,'') || COALESCE(OLD.facts_summary,'') || COALESCE(OLD.edited_summary,'') || COALESCE(OLD.updated_at,'') AS BLOB))) WHERE user_key=NEW.user_key;
  SELECT CASE WHEN (152+length(CAST(COALESCE(NEW.user_key,'') || COALESCE(NEW.date,'') || COALESCE(NEW.facts_summary,'') || COALESCE(NEW.edited_summary,'') || COALESCE(NEW.updated_at,'') AS BLOB)))>(152+length(CAST(COALESCE(OLD.user_key,'') || COALESCE(OLD.date,'') || COALESCE(OLD.facts_summary,'') || COALESCE(OLD.edited_summary,'') || COALESCE(OLD.updated_at,'') AS BLOB))) AND EXISTS(SELECT 1 FROM learning_journal_settings WHERE user_key=NEW.user_key AND (storage_bytes>67108864)) THEN RAISE(ABORT,'journal_capacity_exceeded') END;
END;
--> statement-breakpoint
CREATE TRIGGER learning_journal_days_usage_delete AFTER DELETE ON learning_journal_days
BEGIN
  UPDATE learning_journal_settings SET storage_bytes=storage_bytes+-(152+length(CAST(COALESCE(OLD.user_key,'') || COALESCE(OLD.date,'') || COALESCE(OLD.facts_summary,'') || COALESCE(OLD.edited_summary,'') || COALESCE(OLD.updated_at,'') AS BLOB))) WHERE user_key=OLD.user_key;
END;
