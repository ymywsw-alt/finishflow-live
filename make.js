export async function make(topic) {
  return {
    step: 1,
    topic,
    status: "baseline_ready"
  };
}
