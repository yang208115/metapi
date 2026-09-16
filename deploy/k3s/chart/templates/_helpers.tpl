{{- define "metapi.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "metapi.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := include "metapi.name" . -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "metapi.envSecretName" -}}
{{- printf "%s-env" (include "metapi.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Effective Secret name sourced by envFrom.
When .Values.existingSecret is set the chart does not create its own Secret and
the Deployment references the operator-supplied one; otherwise the chart-managed
helper name is used.
*/}}
{{- define "metapi.envSecretRefName" -}}
{{- if .Values.existingSecret -}}
{{- .Values.existingSecret -}}
{{- else -}}
{{- include "metapi.envSecretName" . -}}
{{- end -}}
{{- end -}}

{{- define "metapi.labels" -}}
app.kubernetes.io/name: {{ include "metapi.name" . }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version | replace "+" "_" }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}
