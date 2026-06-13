-- Track tag-scan state per instance: 0=not scanned, 1=tags applied, 2=no usable tags
ALTER TABLE song_instances ADD COLUMN tag_scanned INTEGER NOT NULL DEFAULT 0;
