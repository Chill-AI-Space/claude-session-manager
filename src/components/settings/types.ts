export interface SettingsComponentProps {
  settings: Record<string, string | undefined>;
  onUpdate: (key: string, value: string) => void;
  savedKey: string | null;
}

export interface HealthCheck {
  id: string;
  label: string;
  ok: boolean;
  required: boolean;
  fix: string | null;
}
