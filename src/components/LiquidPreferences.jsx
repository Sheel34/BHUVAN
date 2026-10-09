import { createContext, useContext, useState } from 'react';

const LiquidPreferences = createContext({ depth: 45, setDepth: () => {} });
export function LiquidPreferencesProvider({ children }) {
  const [depth, setDepth] = useState(45);
  return <LiquidPreferences.Provider value={{ depth, setDepth }}>{children}</LiquidPreferences.Provider>;
}
export const useLiquidPreferences = () => useContext(LiquidPreferences);
