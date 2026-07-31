import { createContext, useContext, type ReactNode } from "react";
import type { Competition } from "../types";
import { useApi } from "../hooks/useApi";

interface CompetitionsCtx {
  competitions: Competition[] | null;
  competitionsLoading: boolean;
}

const CompetitionsContext = createContext<CompetitionsCtx>({
  competitions: null,
  competitionsLoading: true,
});

export function CompetitionsProvider({ children }: { children: ReactNode }) {
  const { data: competitions, loading: competitionsLoading } = useApi<Competition[]>("/api/competitions");
  return (
    <CompetitionsContext.Provider value={{ competitions, competitionsLoading }}>
      {children}
    </CompetitionsContext.Provider>
  );
}

export function useCompetitions(): CompetitionsCtx {
  return useContext(CompetitionsContext);
}
