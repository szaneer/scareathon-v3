import { useQuery } from '@tanstack/react-query';

export type Features = {
  geoBlock: boolean;
  geoAllowedCountries: string[];
  ageGate: boolean;
  ageGateMinAge: number | null;
  termsAcceptance: boolean;
  termsVersion: string | null;
  reports: boolean;
  legalContactEmail: string | null;
  legalOwnerName: string | null;
  accountDeletion: boolean;
  emailChange: boolean;
};
export const dormant: Features = { geoBlock: false, geoAllowedCountries: [], ageGate: false, ageGateMinAge: null, termsAcceptance: false, termsVersion: null, reports: false, legalContactEmail: null, legalOwnerName: null, accountDeletion: false, emailChange: true };
export function useFeatures(mock?: Features) {
  const query = useQuery({
    queryKey: ['station-features'],
    enabled: !mock,
    queryFn: async (): Promise<Features> => {
      const base = (import.meta.env.VITE_BASE_URL || '').replace(/\/$/, '');
      const response = await fetch(`${base}/config/features`);
      if (!response.ok) throw new Error('Station configuration unavailable');
      return response.json() as Promise<Features>;
    },
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
  return mock ?? query.data ?? dormant;
}
