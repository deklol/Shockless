import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { OriginsUserLookupResult } from "../../../shared/window-api";
import type { RuntimeUserSummary } from "../../engineRuntime";
import { compactValue } from "../common/model";
import { writeClipboardText } from "../injection/model";
import type { VisitorEntry } from "../visitors/model";

export interface UserToolsContext {
  readonly activeStoredUserLook: string;
  readonly appendTimeline: (severity: "info" | "success" | "warning" | "error", message: string) => void;
  readonly filteredVisitorEntries: readonly VisitorEntry[];
  readonly publicLookupName: string;
  readonly selectedUser: RuntimeUserSummary | null;
  readonly selectedUserAccountId: string;
  readonly selectedUserBadgeCode: string;
  readonly selectedUserFigure: string;
  readonly selectedUserGender: string;
  readonly selectedUserIndex: string;
  readonly selectedUserMotto: string;
  readonly selectedUserName: string;
  readonly selectedUserPoolFigure: string;
  readonly selectedUserPosition: string;
  readonly selectedUserType: string;
  readonly setPublicLookupBusy: Dispatch<SetStateAction<boolean>>;
  readonly setPublicLookupName: Dispatch<SetStateAction<string>>;
  readonly setPublicLookupResult: Dispatch<SetStateAction<OriginsUserLookupResult | null>>;
  readonly setSelectedStoredUserLook: Dispatch<SetStateAction<string>>;
  readonly setUserStoredLooks: Dispatch<SetStateAction<string[]>>;
  readonly setUserToolMessage: Dispatch<SetStateAction<string>>;
  readonly setVisitorLookupBusy: Dispatch<SetStateAction<boolean>>;
  readonly setVisitorLookupMessage: Dispatch<SetStateAction<string>>;
  readonly setVisitorPublicProfiles: Dispatch<SetStateAction<Readonly<Record<string, OriginsUserLookupResult>>>>;
}

export function useUserTools(context: UserToolsContext) {
  const {
    activeStoredUserLook, appendTimeline, filteredVisitorEntries, publicLookupName, selectedUser,
    selectedUserAccountId, selectedUserBadgeCode, selectedUserFigure, selectedUserGender, selectedUserIndex,
    selectedUserMotto, selectedUserName, selectedUserPoolFigure, selectedUserPosition, selectedUserType,
    setPublicLookupBusy, setPublicLookupName, setPublicLookupResult, setSelectedStoredUserLook, setUserStoredLooks,
    setUserToolMessage, setVisitorLookupBusy, setVisitorLookupMessage, setVisitorPublicProfiles,
  } = context;

const copyUserValue = useCallback(
    async (label: string, value: unknown) => {
      const text = compactValue(value);
      if (text === "-") {
        const message = `${label} is not exposed by the current room user data.`;
        setUserToolMessage(message);
        appendTimeline("warning", message);
        return;
      }
      const copied = await writeClipboardText(text);
      const message = copied ? `Copied ${label}.` : `Clipboard is unavailable for ${label}.`;
      setUserToolMessage(message);
      appendTimeline(copied ? "success" : "warning", message);
    },
    [appendTimeline],
  );

  const lookupPublicUser = useCallback(async () => {
    const name = publicLookupName.trim() || selectedUserName;
    if (!name || name === "-") {
      setPublicLookupResult({
        ok: false,
        query: "",
        source: "official-origins-public-api",
        id: "",
        name: "",
        figureString: "",
        motto: "",
        memberSince: "",
        profileVisible: null,
        selectedBadges: [],
        message: "Enter a Habbo name to look up.",
      });
      return;
    }
    if (!window.shockless) {
      setPublicLookupResult({
        ok: false,
        query: name,
        source: "official-origins-public-api",
        id: "",
        name,
        figureString: "",
        motto: "",
        memberSince: "",
        profileVisible: null,
        selectedBadges: [],
        message: "Desktop bridge is not available in browser preview.",
      });
      return;
    }
    setPublicLookupBusy(true);
    try {
      const result = await window.shockless.lookupOriginsUser(name);
      setPublicLookupResult(result);
      if (!publicLookupName.trim() && result.name) setPublicLookupName(result.name);
      appendTimeline(result.ok ? "success" : "warning", result.message);
    } finally {
      setPublicLookupBusy(false);
    }
  }, [appendTimeline, publicLookupName, selectedUserName]);

  const lookupMissingVisitorProfiles = useCallback(async () => {
    const missing = filteredVisitorEntries
      .filter((entry) => entry.accountId === "-" && entry.name && entry.name !== "-")
      .map((entry) => entry.name.trim())
      .filter(Boolean);
    const uniqueNames = [...new Set(missing.map((name) => name.toLowerCase()))]
      .map((lowerName) => missing.find((name) => name.toLowerCase() === lowerName) ?? lowerName);

    if (uniqueNames.length === 0) {
      const message = "No visitors need public profile lookup.";
      setVisitorLookupMessage(message);
      appendTimeline("info", message);
      return;
    }
    if (!window.shockless) {
      const message = "Desktop bridge is not available for public visitor lookup.";
      setVisitorLookupMessage(message);
      appendTimeline("warning", message);
      return;
    }

    setVisitorLookupBusy(true);
    let found = 0;
    try {
      const updates: Record<string, OriginsUserLookupResult> = {};
      for (const name of uniqueNames) {
        const result = await window.shockless.lookupOriginsUser(name);
        updates[name.toLowerCase()] = result;
        if (result.ok && result.id) found += 1;
      }
      setVisitorPublicProfiles((current) => ({ ...current, ...updates }));
      const message = `Public lookup checked ${uniqueNames.length} visitor${uniqueNames.length === 1 ? "" : "s"}; ${found} id${found === 1 ? "" : "s"} found.`;
      setVisitorLookupMessage(message);
      appendTimeline(found > 0 ? "success" : "warning", message);
    } finally {
      setVisitorLookupBusy(false);
    }
  }, [appendTimeline, filteredVisitorEntries]);

  const copySelectedUserProfile = useCallback(async () => {
    if (!selectedUser) {
      const message = "No room user is selected.";
      setUserToolMessage(message);
      appendTimeline("warning", message);
      return;
    }
    const profile = [
      `Name: ${selectedUserName}`,
      `Account: ${selectedUserAccountId}`,
      `Index: ${selectedUserIndex}`,
      `Gender: ${selectedUserGender}`,
      `Type: ${selectedUserType}`,
      `Badge: ${selectedUserBadgeCode}`,
      `Motto: ${selectedUserMotto}`,
      `Position: ${selectedUserPosition}`,
      `Direction: ${compactValue(selectedUser.direction)}`,
      `Figure: ${selectedUserFigure}`,
      `PH Figure: ${selectedUserPoolFigure}`,
    ].join("\n");
    const copied = await writeClipboardText(profile);
    const message = copied ? "Copied selected user profile snapshot." : "Clipboard is unavailable for the profile snapshot.";
    setUserToolMessage(message);
    appendTimeline(copied ? "success" : "warning", message);
  }, [
    appendTimeline,
    selectedUser,
    selectedUserAccountId,
    selectedUserBadgeCode,
    selectedUserFigure,
    selectedUserGender,
    selectedUserIndex,
    selectedUserMotto,
    selectedUserName,
    selectedUserPoolFigure,
    selectedUserPosition,
    selectedUserType,
  ]);

  const storeSelectedUserLook = useCallback(() => {
    if (!selectedUser || selectedUserFigure === "-") {
      const message = "Selected user figure is not exposed by the current room data.";
      setUserToolMessage(message);
      appendTimeline("warning", message);
      return;
    }
    setUserStoredLooks((current) => [selectedUserFigure, ...current.filter((entry) => entry !== selectedUserFigure)].slice(0, 20));
    setSelectedStoredUserLook(selectedUserFigure);
    const message = `Stored parsed look for ${selectedUserName}.`;
    setUserToolMessage(message);
    appendTimeline("success", message);
  }, [appendTimeline, selectedUser, selectedUserFigure, selectedUserName]);

  const copyStoredUserLook = useCallback(async () => {
    const look = activeStoredUserLook.trim();
    if (!look) {
      const message = "No stored user look is available.";
      setUserToolMessage(message);
      appendTimeline("warning", message);
      return;
    }
    const copied = await writeClipboardText(look);
    const message = copied ? "Copied stored user look." : "Clipboard is unavailable for the stored look.";
    setUserToolMessage(message);
    appendTimeline(copied ? "success" : "warning", message);
  }, [activeStoredUserLook, appendTimeline]);

  const clearStoredUserLooks = useCallback(() => {
    setUserStoredLooks([]);
    setSelectedStoredUserLook("");
    setUserToolMessage("Stored user looks cleared.");
  }, []);

  return {
    clearStoredUserLooks,
    copySelectedUserProfile,
    copyStoredUserLook,
    lookupMissingVisitorProfiles,
    lookupPublicUser,
    storeSelectedUserLook,
  };
}
