"""Use bigint for millisecond timestamps; SQLite batch mode supported."""
from alembic import op
import sqlalchemy as sa
revision = '573c60aa8eb3'
down_revision = 'fe4bea3e91e8'
branch_labels = None
depends_on = None
COLUMNS = {'application_events':['created_at'], 'conveyor_applications':['created_at'],
           'conveyor_chat':['created_at'], 'credit_applications':['created_at','updated_at'],
           'credit_assessments':['created_at'], 'uploaded_documents':['created_at']}
def upgrade():
    for table, columns in COLUMNS.items():
        with op.batch_alter_table(table) as batch:
            for column in columns:
                batch.alter_column(column, existing_type=sa.Integer(), type_=sa.BigInteger(), existing_nullable=False)
def downgrade():
    raise RuntimeError('Millisecond timestamps cannot safely be narrowed to PostgreSQL int32; restore a backup instead.')
