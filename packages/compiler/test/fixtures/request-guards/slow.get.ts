export default async () => {
  await new Promise((resolve) => setTimeout(resolve, 100));
  return new Response("late");
};
