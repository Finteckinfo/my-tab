import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const count = await prisma.pledgeMirror.count();
  console.log(`DB has ${count} pledges after backfill.`);
  
  const pledges = await prisma.pledgeMirror.findMany();
  console.log(pledges.map(p => p.status));
}

main().finally(() => prisma.$disconnect());
