output "db_endpoint" { value = aws_db_instance.mysql.address }
output "db_master_secret_arn" { value = aws_db_instance.mysql.master_user_secret[0].secret_arn }
output "redis_primary_endpoint" { value = aws_elasticache_replication_group.redis.primary_endpoint_address }
output "documents_bucket" { value = aws_s3_bucket.documents.bucket }
output "kms_key_arn" { value = aws_kms_key.data.arn }
