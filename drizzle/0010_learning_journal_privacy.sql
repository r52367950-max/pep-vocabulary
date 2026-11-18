/* Retain deliberate user edits, erase automatic free text and private material
   identifiers, and fence queues/context captured before this privacy change. */
CREATE TABLE `_journal_privacy_days` (`user_key` text NOT NULL, `date` text NOT NULL, PRIMARY KEY (`user_key`,`date`));
--> statement-breakpoint
INSERT INTO _journal_privacy_days SELECT DISTINCT user_key,date FROM learning_journal_events WHERE kind IN ('voice','assistant','reading','dictation');
--> statement-breakpoint
UPDATE learning_journal_settings SET revision=revision+1, privacy_revision=privacy_revision+1,
  suppressed_before=MAX(suppressed_before,strftime('%Y-%m-%dT%H:%M:%fZ','now'),COALESCE((SELECT MAX(occurred_at) FROM learning_journal_events e WHERE e.user_key=learning_journal_settings.user_key),'')), write_token=''
  WHERE user_key IN (SELECT user_key FROM _journal_privacy_days);
--> statement-breakpoint
DELETE FROM learning_journal_events WHERE kind='reading' AND edited=0 AND
  (event_id LIKE 'reading-personal-%' OR EXISTS(SELECT 1 FROM json_each(ref_ids) WHERE value LIKE 'personal-%'));
--> statement-breakpoint
UPDATE learning_journal_events SET event_id='journal-' || lower(hex(randomblob(16))), ref_ids='[]', content_hash=''
  WHERE kind='reading' AND edited=1 AND (event_id LIKE 'reading-personal-%' OR EXISTS(SELECT 1 FROM json_each(ref_ids) WHERE value LIKE 'personal-%'));
--> statement-breakpoint
UPDATE learning_journal_events SET
  title=CASE WHEN edited=1 THEN title ELSE CASE kind WHEN 'voice' THEN '口语练习' WHEN 'assistant' THEN 'AI 学习练习' WHEN 'reading' THEN '阅读练习' ELSE '听写练习' END END,
  summary=CASE WHEN edited=1 THEN summary ELSE '' END,ref_ids='[]',content_hash='',
  counts=COALESCE((SELECT json_group_object(key,value) FROM json_each(counts) WHERE
    (kind='voice' AND key IN ('seconds','turns')) OR (kind='assistant' AND key IN ('tasks','discussions')) OR
    (kind='reading' AND key='opened') OR (kind='dictation' AND key IN ('total','correct','assisted'))),'{}')
  WHERE kind IN ('voice','assistant','reading','dictation') AND deleted=0;
--> statement-breakpoint
UPDATE learning_journal_days SET facts_summary=CASE
  WHEN (SELECT count(*) FROM learning_journal_events e WHERE e.user_key=learning_journal_days.user_key AND e.date=learning_journal_days.date AND deleted=0)=0 THEN ''
  ELSE '记录了 ' || (SELECT count(*) FROM learning_journal_events e WHERE e.user_key=learning_journal_days.user_key AND e.date=learning_journal_days.date AND deleted=0) || ' 项学习活动。' END,
  updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE EXISTS(SELECT 1 FROM _journal_privacy_days p WHERE p.user_key=learning_journal_days.user_key AND p.date=learning_journal_days.date);
--> statement-breakpoint
DROP TABLE _journal_privacy_days;
