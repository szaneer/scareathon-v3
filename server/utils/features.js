export function allowedCountries(env = process.env) {
    return [...new Set((env.GEO_ALLOWED_COUNTRIES || '').split(',').map(code => code.trim().toUpperCase()).filter(code => /^[A-Z]{2}$/.test(code)))];
}
export function minimumAge(env = process.env) {
    const age = Number(env.AGE_GATE_MIN_AGE);
    return Number.isInteger(age) && age >= 13 && age <= 120 ? age : null;
}
export function deletionEnabled(env = process.env) {
    return Boolean(env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY);
}
export function termsVersion(env = process.env) {
    return env.LEGAL_CONTACT_EMAIL?.trim() && env.TERMS_VERSION?.trim() ? env.TERMS_VERSION.trim() : null;
}
export function publicFeatures(env = process.env, geoReady = false) {
    const countries = allowedCountries(env);
    return {
        geoBlock: countries.length > 0 && geoReady,
        geoAllowedCountries: countries,
        ageGate: minimumAge(env) !== null,
        ageGateMinAge: minimumAge(env),
        termsAcceptance: termsVersion(env) !== null,
        termsVersion: termsVersion(env),
        reports: env.REPORTS_ENABLED === 'true',
        legalContactEmail: env.LEGAL_CONTACT_EMAIL?.trim() || null,
        legalOwnerName: env.LEGAL_OWNER_NAME?.trim() || null,
        accountDeletion: deletionEnabled(env),
        emailChange: env.EMAIL_CHANGE_ENABLED !== 'false',
    };
}
