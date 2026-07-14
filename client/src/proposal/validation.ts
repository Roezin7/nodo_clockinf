import type { AcceptanceInput } from './types';

export type AcceptanceErrors = Partial<Record<keyof AcceptanceInput, string>>;

export function validateAcceptance(input: AcceptanceInput): AcceptanceErrors {
  const errors: AcceptanceErrors = {};
  if (input.legalCompanyName.trim().length < 2) errors.legalCompanyName = 'Ingresa el nombre legal de la empresa.';
  if (input.representativeName.trim().length < 2) errors.representativeName = 'Ingresa el nombre del representante.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim())) errors.email = 'Ingresa un correo válido.';
  if (input.phone.replace(/\D/g, '').length < 7) errors.phone = 'Ingresa un teléfono válido.';
  if (!Number.isInteger(input.stations) || input.stations < 1) errors.stations = 'Selecciona al menos una estación.';
  if (!input.pricingConfirmed) errors.pricingConfirmed = 'Confirma la estructura de precios.';
  if (!input.termsAccepted) errors.termsAccepted = 'Acepta los términos mostrados.';
  const normalize = (value: string) => value.trim().toLocaleLowerCase('es').replace(/\s+/g, ' ');
  if (normalize(input.signature) !== normalize(input.representativeName) || !input.signature.trim()) {
    errors.signature = 'Escribe el nombre del representante exactamente como firma.';
  }
  return errors;
}
