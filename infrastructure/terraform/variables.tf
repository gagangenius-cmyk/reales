variable "region" {
  type    = string
  default = "me-central-1" # AWS UAE
}
variable "environment" { type = string }
variable "name_prefix" {
  type        = string
  description = "Globally unique prefix for the S3 bucket name"
}
variable "vpc_id" { type = string }
variable "private_subnet_ids" { type = list(string) }
variable "app_security_group_id" { type = string }
variable "db_instance_class" {
  type    = string
  default = "db.m6g.large"
}
variable "db_storage_gb" {
  type    = number
  default = 100
}
variable "backup_retention_days" {
  type    = number
  default = 14
}
variable "redis_node_type" {
  type    = string
  default = "cache.t4g.small"
}
variable "noncurrent_version_days" {
  type    = number
  default = 365
}
