import type { LLMProvider } from "@/lib/ai/provider";
import { GoogleAiStudioProvider } from "@/lib/ai/providers/google-ai-studio";
import { LocalLlmProvider } from "@/lib/ai/providers/local-llm";

type ProviderType = "google" | "local";

const globalForAiProvider = globalThis as unknown as {
  aiProvider?: LLMProvider;
  aiProviderType?: ProviderType;
};

function resolveProviderType(): ProviderType {
  const raw = process.env.AI_PROVIDER?.trim().toLowerCase() ?? "google";

  if (!raw || raw === "google") {
    return "google";
  }

  if (raw === "local") {
    return "local";
  }

  throw new Error(
    `Unsupported AI_PROVIDER value "${raw}". Use "google" or "local".`,
  );
}

function createProvider(type: ProviderType): LLMProvider {
  if (type === "local") {
    return new LocalLlmProvider();
  }
  return new GoogleAiStudioProvider();
}

export function getProvider(): LLMProvider {
  const providerType = resolveProviderType();

  if (
    globalForAiProvider.aiProvider &&
    globalForAiProvider.aiProviderType === providerType
  ) {
    return globalForAiProvider.aiProvider;
  }

  const provider = createProvider(providerType);
  globalForAiProvider.aiProvider = provider;
  globalForAiProvider.aiProviderType = providerType;
  return provider;
}
