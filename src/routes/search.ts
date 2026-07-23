import { Router } from "express";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

const router = Router();

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Generate embedding
router.post("/embed", async (req, res) => {
  try {
    const { text } = req.body;

    const response = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: text,
    });

    res.json({ embedding: response.data[0].embedding });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Semantic search using vector similarity
router.post("/semantic", async (req, res) => {
  try {
    const { query, filters } = req.body;

    // Generate embedding for query
    const embedResponse = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: query,
    });
    const embedding = embedResponse.data[0].embedding;

    // Search using pgvector
    const { data, error } = await supabase.rpc("search_programs_vector", {
      query_embedding: embedding,
      match_threshold: 0.7,
      match_count: 20,
    });

    if (error) throw error;

    // Also search institutions
    const { data: institutions, error: instError } = await supabase.rpc("search_institutions_vector", {
      query_embedding: embedding,
      match_threshold: 0.7,
      match_count: 10,
    });

    if (instError) throw instError;

    // Combine and rank results
    const combined = [
      ...(data || []).map((r: any) => ({ ...r, type: "program" })),
      ...(institutions || []).map((r: any) => ({ ...r, type: "institution" })),
    ].sort((a, b) => b.similarity - a.similarity);

    res.json({ results: combined.slice(0, 20), query });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Direct vector search (for advanced use)
router.post("/vector", async (req, res) => {
  try {
    const { embedding, filters } = req.body;

    const { data, error } = await supabase.rpc("search_all_vector", {
      query_embedding: embedding,
      match_threshold: filters?.threshold || 0.7,
      match_count: filters?.limit || 20,
    });

    if (error) throw error;
    res.json({ results: data || [] });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Search suggestions (for autocomplete)
router.get("/suggestions", async (req, res) => {
  try {
    const { q } = req.query;

    // Use existing Claude-based search for suggestions
    const { data: programs } = await supabase
      .from("programs")
      .select("name, field_of_study")
      .ilike("name", `%${q}%`)
      .limit(5);

    const { data: institutions } = await supabase
      .from("institutions")
      .select("name, country")
      .ilike("name", `%${q}%`)
      .limit(5);

    const suggestions = [
      ...(programs || []).map((p: any) => ({
        text: p.name,
        type: "program",
        confidence: 0.9,
      })),
      ...(institutions || []).map((i: any) => ({
        text: i.name,
        type: "institution",
        confidence: 0.85,
      })),
    ];

    res.json({ suggestions: suggestions.slice(0, 8) });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Hybrid search (combines semantic + keyword)
router.post("/hybrid", async (req, res) => {
  try {
    const { query, filters } = req.body;

    // Get vector results
    const embedResponse = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: query,
    });
    const embedding = embedResponse.data[0].embedding;

    const { data: vectorResults } = await supabase.rpc("search_hybrid", {
      query_text: query,
      query_embedding: embedding,
      match_count: 20,
    });

    res.json({ results: vectorResults || [] });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
