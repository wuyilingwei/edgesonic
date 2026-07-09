INSERT INTO work_queue (id, task_type, payload, priority, status, attempts, max_attempts, required_caps, created_at)
SELECT 'wt-metadata-' || si.id, 'metadata', json_object('instanceId', si.id, 'sourceUri', si.storage_uri, 'suffix', si.suffix, 'size', si.size), 5, 'queued', 0, 3, '["music-metadata"]', unixepoch()
FROM song_instances si
WHERE si.tag_scanned = 0
ON CONFLICT(id) DO UPDATE SET status='queued', attempts=0, error_message=NULL;