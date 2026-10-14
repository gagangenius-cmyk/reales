# UNVALIDATED SKELETON (no terraform binary was available when this was written): run `terraform init && terraform validate && terraform plan` and review
# every resource with your cloud/security team. It assumes an existing VPC with private subnets and targets the AWS UAE region (me-central-1) so that
# data stays in-country by default; change `region` deliberately, and keep the data-processing policy in the application consistent with it.

terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

provider "aws" {
  region = var.region
  default_tags { tags = { Project = "reales", Environment = var.environment, DataRegion = var.region } }
}

resource "aws_kms_key" "data" {
  description             = "reales ${var.environment} data-at-rest"
  enable_key_rotation     = true
  deletion_window_in_days = 30
}

resource "aws_security_group" "data" {
  name_prefix = "reales-${var.environment}-data-"
  vpc_id      = var.vpc_id
  ingress {
    description     = "MySQL from the application"
    from_port       = 3306
    to_port         = 3306
    protocol        = "tcp"
    security_groups = [var.app_security_group_id]
  }
  ingress {
    description     = "Redis from the application"
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [var.app_security_group_id]
  }
}

resource "aws_db_subnet_group" "main" {
  name       = "reales-${var.environment}"
  subnet_ids = var.private_subnet_ids
}

resource "aws_db_instance" "mysql" {
  identifier                      = "reales-${var.environment}"
  engine                          = "mysql"
  engine_version                  = "8.4"
  instance_class                  = var.db_instance_class
  allocated_storage               = var.db_storage_gb
  max_allocated_storage           = var.db_storage_gb * 4
  storage_encrypted               = true
  kms_key_id                      = aws_kms_key.data.arn
  db_name                         = "reales"
  username                        = "reales"
  manage_master_user_password     = true # password stays in Secrets Manager, never in state
  multi_az                        = true
  backup_retention_period         = var.backup_retention_days
  backup_window                   = "01:00-02:00"
  deletion_protection             = true
  skip_final_snapshot             = false
  final_snapshot_identifier       = "reales-${var.environment}-final"
  db_subnet_group_name            = aws_db_subnet_group.main.name
  vpc_security_group_ids          = [aws_security_group.data.id]
  parameter_group_name            = aws_db_parameter_group.mysql.name
  enabled_cloudwatch_logs_exports = ["error", "slowquery"]
  performance_insights_enabled    = true
  auto_minor_version_upgrade      = true
}

# Triggers (append-only tables, audit) need this when binary logging is on.
resource "aws_db_parameter_group" "mysql" {
  name_prefix = "reales-${var.environment}-"
  family      = "mysql8.4"
  parameter {
    name  = "log_bin_trust_function_creators"
    value = "1"
  }
  parameter {
    name  = "character_set_server"
    value = "utf8mb4"
  }
}

resource "aws_elasticache_subnet_group" "redis" {
  name       = "reales-${var.environment}"
  subnet_ids = var.private_subnet_ids
}

resource "aws_elasticache_replication_group" "redis" {
  replication_group_id       = "reales-${var.environment}"
  description                = "reales queues and rate limits"
  engine                     = "redis"
  node_type                  = var.redis_node_type
  num_cache_clusters         = 2
  automatic_failover_enabled = true
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  kms_key_id                 = aws_kms_key.data.arn
  subnet_group_name          = aws_elasticache_subnet_group.redis.name
  security_group_ids         = [aws_security_group.data.id]
  snapshot_retention_limit   = 7
}

resource "aws_s3_bucket" "documents" {
  bucket = "${var.name_prefix}-reales-${var.environment}-documents"
}

resource "aws_s3_bucket_versioning" "documents" {
  bucket = aws_s3_bucket.documents.id
  versioning_configuration { status = "Enabled" } # document versions are immutable in the app; versioning protects against accidental deletes
}

resource "aws_s3_bucket_server_side_encryption_configuration" "documents" {
  bucket = aws_s3_bucket.documents.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.data.arn
    }
  }
}

resource "aws_s3_bucket_public_access_block" "documents" {
  bucket                  = aws_s3_bucket.documents.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "documents" {
  bucket = aws_s3_bucket.documents.id
  rule {
    id     = "expire-noncurrent"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration { noncurrent_days = var.noncurrent_version_days }
  }
}

# Cross-region copy of backups is intentionally NOT configured: it would move data out of the UAE. Add it only after the data-processing policy allows it.
