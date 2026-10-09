ALTER TABLE public.users ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS terms_version_accepted TEXT;

-- Extend the existing guard: acceptance is recorded by the authenticated API,
-- never by a direct Supabase profile write.
CREATE OR REPLACE FUNCTION public.station_protect_compliance_fields() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF current_user IN ('anon', 'authenticated') THEN
        IF TG_OP = 'INSERT' THEN
            IF NEW.age_confirmed_at IS NOT NULL OR NEW.content_restricted_at IS NOT NULL
               OR NEW.terms_accepted_at IS NOT NULL OR NEW.terms_version_accepted IS NOT NULL THEN
                RAISE EXCEPTION 'Compliance fields are managed by the station API';
            END IF;
        ELSIF NEW.age_confirmed_at IS DISTINCT FROM OLD.age_confirmed_at
           OR NEW.content_restricted_at IS DISTINCT FROM OLD.content_restricted_at
           OR NEW.terms_accepted_at IS DISTINCT FROM OLD.terms_accepted_at
           OR NEW.terms_version_accepted IS DISTINCT FROM OLD.terms_version_accepted THEN
            RAISE EXCEPTION 'Compliance fields are managed by the station API';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
