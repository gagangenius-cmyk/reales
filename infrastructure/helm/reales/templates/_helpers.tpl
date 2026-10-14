{{- define "reales.image" -}}{{ .Values.image.repository }}:{{ .Values.image.tag }}{{- end -}}

{{- define "reales.podSecurity" -}}
securityContext:
  runAsNonRoot: true
  runAsUser: 1000
  seccompProfile:
    type: RuntimeDefault
{{- end -}}

{{- define "reales.containerSecurity" -}}
securityContext:
  allowPrivilegeEscalation: false
  capabilities:
    drop: ["ALL"]
{{- end -}}

{{- define "reales.env" -}}
envFrom:
  - configMapRef:
      name: {{ .Release.Name }}-config
  - secretRef:
      name: {{ .Values.existingSecret }}
{{- end -}}
