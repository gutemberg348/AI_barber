// Compatibilidade de leitura para celulares brasileiros que chegam pelo canal
// sem o nono dígito ou foram cadastrados no site no formato antigo.
// Nunca usa números escritos pelo cliente nem altera identidade/chave de escrita.
export function appointmentPhoneVariants(value) {
  if (typeof value !== 'string') return [];
  let phone = value;
  if (/^55\d{10,11}$/.test(phone)) phone = phone.slice(2);
  if (!/^[1-9]\d{9,10}$/.test(phone)) return [value];
  if (/^[1-9]\d[6-9]\d{7}$/.test(phone)) return [phone, `${phone.slice(0, 2)}9${phone.slice(2)}`];
  if (/^[1-9]\d9[6-9]\d{7}$/.test(phone)) return [phone, phone.slice(0, 2) + phone.slice(3)];
  return [phone];
}
