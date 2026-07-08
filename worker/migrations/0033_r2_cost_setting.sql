-- 101: R2 cost estimation — free-tier allocation setting
INSERT OR IGNORE INTO feature_strings (key, value, description, updated_at) VALUES
  ('r2_free_allocation_gb', '10',
   'GB of R2 free tier (10 GB total) allocated to EdgeSonic for monthly cost estimation',
   unixepoch());
