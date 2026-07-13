export interface NamedPlantDevice {
  plant_id: string;
  name: string;
  active: boolean;
}

export function kioskNamesToReachTarget(
  devices: NamedPlantDevice[],
  plantId: string,
  targetActive = 2
): string[] {
  const inPlant = devices.filter((device) => device.plant_id === plantId);
  const missing = Math.max(0, targetActive - inPlant.filter((device) => device.active).length);
  const used = new Set(inPlant.map((device) => device.name));
  const names: string[] = [];
  for (let suffix = 1; names.length < missing; suffix += 1) {
    const candidate = `Kiosco ${suffix}`;
    if (used.has(candidate)) continue;
    used.add(candidate);
    names.push(candidate);
  }
  return names;
}

